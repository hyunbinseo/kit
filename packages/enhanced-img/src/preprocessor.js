import { existsSync } from 'node:fs';
import * as path from 'node:path';

import MagicString from 'magic-string';
import { asyncWalk } from 'estree-walker';
import { VERSION } from 'svelte/compiler';
import { parse } from 'svelte-parse-markup';

// TODO: expose this in vite-imagetools rather than duplicating it
const OPTIMIZABLE = /^[^?]+\.(avif|heif|gif|jpeg|jpg|png|tiff|webp)(\?.*)?$/;

/**
 * @param {{
 *   plugin_context: import('vite').Rollup.PluginContext
 *   vite_config: import('vite').ResolvedConfig
 *   imagetools_plugin: import('vite').Plugin
 * }} opts
 * @returns {import('svelte/types/compiler/preprocess').PreprocessorGroup}
 */
export function image(opts) {
	// TODO: clear this map in dev mode to avoid memory leak
	/**
	 * URL to image details
	 * @type {Map<string, import('vite-imagetools').Picture>}
	 */
	const images = new Map();

	return {
		async markup({ content, filename }) {
			if (!content.includes('<enhanced:img')) {
				return;
			}

			const s = new MagicString(content);
			const ast = parse(content, { filename });

			/**
			 * Import path to import name
			 * e.g. ./foo.png => __IMPORTED_ASSET_0__
			 * @type {Map<string, string>}
			 */
			const imports = new Map();

			/**
			 * Vite name to declaration name
			 * e.g. __VITE_ASSET_0__ => __DECLARED_ASSET_0__
			 * @type {Map<string, string>}
			 */
			const consts = new Map();

			/**
			 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
			 * @param {{ type: string, start: number, end: number, raw: string }} src_attribute
			 * @returns {Promise<void>}
			 */
			async function update_element(node, src_attribute) {
				// TODO: this will become ExpressionTag in Svelte 5
				if (src_attribute.type === 'MustacheTag') {
					const src_var_name = content
						.substring(src_attribute.start + 1, src_attribute.end - 1)
						.trim();
					s.update(node.start, node.end, dynamic_img_to_picture(content, node, src_var_name));
					return;
				} else if (src_attribute.type === 'AttributeShorthand') {
					const src_var_name = content.substring(src_attribute.start, src_attribute.end).trim();
					s.update(node.start, node.end, dynamic_img_to_picture(content, node, src_var_name));
					return;
				}

				const original_url = src_attribute.raw.trim();
				let url = original_url;

				const sizes = get_attr_value(node, 'sizes');
				const width = get_attr_value(node, 'width');
				url += url.includes('?') ? '&' : '?';
				if (sizes) {
					url += 'imgSizes=' + encodeURIComponent(sizes.raw) + '&';
				}
				if (width) {
					url += 'imgWidth=' + encodeURIComponent(width.raw) + '&';
				}
				url += 'enhanced';

				if (OPTIMIZABLE.test(url)) {
					// resolves the import so that we can build the entire picture template string and don't
					// need any logic blocks
					const resolved_id = (await opts.plugin_context.resolve(url, filename))?.id;
					if (!resolved_id) {
						const file_path = url.substring(0, url.indexOf('?'));
						if (existsSync(path.resolve(opts.vite_config.publicDir, file_path))) {
							throw new Error(
								`Could not locate ${file_path}. Please move it to be located relative to the page in the routes directory or reference it beginning with /static/. See https://vitejs.dev/guide/assets for more details on referencing assets.`
							);
						}
						throw new Error(
							`Could not locate ${file_path}. See https://vitejs.dev/guide/assets for more details on referencing assets.`
						);
					}

					let image = images.get(resolved_id);
					if (!image) {
						image = await process(resolved_id, opts);
						images.set(resolved_id, image);
					}
					s.update(node.start, node.end, img_to_picture(consts, content, node, image));
				} else {
					// e.g. <img src="./foo.svg" /> => <img src={__IMPORTED_ASSET_0__} />
					const name = '__IMPORTED_ASSET_' + imports.size + '__';
					const { start, end } = src_attribute;
					// update src with reference to imported asset
					s.update(
						is_quote(content, start - 1) ? start - 1 : start,
						is_quote(content, end) ? end + 1 : end,
						`{${name}}`
					);
					// update `enhanced:img` to `img`
					s.update(node.start + 1, node.start + 1 + 'enhanced:img'.length, 'img');
					imports.set(original_url, name);
				}
			}

			// TODO: switch to zimmerframe with Svelte 5
			// @ts-ignore
			await asyncWalk(ast.html, {
				/**
				 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
				 */
				async enter(node) {
					if (node.type === 'Element') {
						// Compare node tag match
						if (node.name === 'enhanced:img') {
							const src = get_attr_value(node, 'src');
							if (!src) return;
							await update_element(node, src);
						}
					}
				}
			});

			// add imports and consts to <script module> block
			let text = '';
			if (imports.size) {
				for (const [path, import_name] of imports.entries()) {
					text += `\timport ${import_name} from "${path}";\n`;
				}
			}

			if (consts.size) {
				for (const [vite_name, declaration_name] of consts.entries()) {
					text += `\tconst ${declaration_name} = "${vite_name}";\n`;
				}
			}

			if (ast.module) {
				// @ts-ignore
				s.appendLeft(ast.module.content.start, text);
			} else {
				s.prepend(
					`<script ${VERSION.startsWith('4') ? 'context="module"' : 'module'}>${text}</script>\n`
				);
			}

			return {
				code: s.toString(),
				map: s.generateMap()
			};
		}
	};
}

/**
 * @param {string} content
 * @param {number} index
 * @returns {boolean}
 */
function is_quote(content, index) {
	return content.charAt(index) === '"' || content.charAt(index) === "'";
}

/**
 * @param {string} resolved_id
 * @param {{
 *   plugin_context: import('vite').Rollup.PluginContext
 *   imagetools_plugin: import('vite').Plugin
 * }} opts
 * @returns {Promise<import('vite-imagetools').Picture>}
 */
async function process(resolved_id, opts) {
	if (!opts.imagetools_plugin.load) {
		throw new Error('Invalid instance of vite-imagetools. Could not find load method.');
	}
	const hook = opts.imagetools_plugin.load;
	const handler = typeof hook === 'object' ? hook.handler : hook;
	const module_info = await handler.call(opts.plugin_context, resolved_id);
	if (!module_info) {
		throw new Error(`Could not load ${resolved_id}`);
	}
	const code = typeof module_info === 'string' ? module_info : module_info.code;
	return parseObject(code.replace('export default', '').replace(/;$/, '').trim());
}

/**
 * @param {string} str
 */
export function parseObject(str) {
	const updated = str
		.replaceAll(/{(\n\s*)?/gm, '{"')
		.replaceAll(':', '":')
		.replaceAll(/,(\n\s*)?([^ ])/g, ',"$2');
	try {
		return JSON.parse(updated);
	} catch {
		throw new Error(`Failed parsing string to object: ${str}`);
	}
}

/**
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {string} attr
 */
function get_attr_value(node, attr) {
	const attribute = node.attributes.find(
		/** @param {any} v */ (v) => v.type === 'Attribute' && v.name === attr
	);

	if (!attribute) return;

	return attribute.value[0];
}

/**
 * @param {string} content
 * @param {Array<import('svelte/types/compiler/interfaces').BaseDirective | import('svelte/types/compiler/interfaces').Attribute | import('svelte/types/compiler/interfaces').SpreadAttribute>} attributes
 * @param {{
 *   src: string,
 *   width: string | number,
 *   height: string | number
 * }} details
 */
function serialize_img_attributes(content, attributes, details) {
	const attribute_strings = attributes.map((attribute) => {
		if (attribute.name === 'src') {
			return `src=${details.src}`;
		}
		return content.substring(attribute.start, attribute.end);
	});

	/** @type {number | undefined} */
	let user_width;
	/** @type {number | undefined} */
	let user_height;
	for (const attribute of attributes) {
		if (attribute.name === 'width') user_width = parseInt(attribute.value[0].raw);
		if (attribute.name === 'height') user_height = parseInt(attribute.value[0].raw);
	}
	if (!user_width && !user_height) {
		attribute_strings.push(`width=${details.width}`);
		attribute_strings.push(`height=${details.height}`);
	} else if (!user_width && user_height) {
		attribute_strings.push(
			`width=${Math.round(
				(stringToNumber(details.width) * user_height) / stringToNumber(details.height)
			)}`
		);
	} else if (!user_height && user_width) {
		attribute_strings.push(
			`height=${Math.round(
				(stringToNumber(details.height) * user_width) / stringToNumber(details.width)
			)}`
		);
	}

	return attribute_strings.join(' ');
}

/**
 * @param {string|number} param
 */
function stringToNumber(param) {
	return typeof param === 'string' ? parseInt(param) : param;
}

/**
 * @param {Map<string,string>} consts
 * @param {string} content
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {import('vite-imagetools').Picture} image
 */
function img_to_picture(consts, content, node, image) {
	/** @type {Array<import('svelte/types/compiler/interfaces').BaseDirective | import('svelte/types/compiler/interfaces').Attribute | import('svelte/types/compiler/interfaces').SpreadAttribute>} attributes */
	const attributes = node.attributes;
	const index = attributes.findIndex((attribute) => attribute.name === 'sizes');
	let sizes_string = '';
	if (index >= 0) {
		sizes_string = ' ' + content.substring(attributes[index].start, attributes[index].end);
		attributes.splice(index, 1);
	}

	let res = '<picture>';

	for (const [format, srcset] of Object.entries(image.sources)) {
		res += `<source srcset=${to_value(consts, srcset)}${sizes_string} type="image/${format}" />`;
	}

	res += `<img ${serialize_img_attributes(content, attributes, {
		src: to_value(consts, image.img.src),
		width: image.img.w,
		height: image.img.h
	})} />`;

	return (res += '</picture>');
}

/**
 * @param {Map<string, string>} consts
 * @param {string} src
 */
function to_value(consts, src) {
	if (src.startsWith('__VITE_ASSET__')) {
		let var_name = consts.get(src);
		if (!var_name) {
			var_name = '__DECLARED_ASSET_' + consts.size + '__';
			consts.set(src, var_name);
		}
		return `{${var_name}}`;
	}
	return `"${src}"`;
}

/**
 * For images like `<img src={manually_imported} />`
 * @param {string} content
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {string} src_var_name
 */
function dynamic_img_to_picture(content, node, src_var_name) {
	/** @type {Array<import('svelte/types/compiler/interfaces').BaseDirective | import('svelte/types/compiler/interfaces').Attribute | import('svelte/types/compiler/interfaces').SpreadAttribute>} attributes */
	const attributes = node.attributes;
	const index = attributes.findIndex((attribute) => attribute.name === 'sizes');
	let sizes_string = '';
	if (index >= 0) {
		sizes_string = ' ' + content.substring(attributes[index].start, attributes[index].end);
		attributes.splice(index, 1);
	}

	const details = {
		src: `{${src_var_name}.img.src}`,
		width: `{${src_var_name}.img.w}`,
		height: `{${src_var_name}.img.h}`
	};

	return `{#if typeof ${src_var_name} === 'string'}
	<img ${serialize_img_attributes(content, node.attributes, details)} />
{:else}
	<picture>
		{#each Object.entries(${src_var_name}.sources) as [format, srcset]}
			<source {srcset}${sizes_string} type={'image/' + format} />
		{/each}
		<img ${serialize_img_attributes(content, attributes, details)} />
	</picture>
{/if}`;
}
