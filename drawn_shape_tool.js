const drawn_shape_tool_resources = {
	dialog: null,
	action: null,
	style: null
};

BBPlugin.register('drawn_shape_tool', {
	id: 'drawn_shape_tool',
	title: '手绘形状生成器',
	author: 'k9-okio',
	description: '手动画线并闭合轮廓，支持对称、局部弯曲与宽度，以及按位置混合方块和三角面；也可在 3D 视口取点，用 2/3/4 个点生成线、面和方块。',
	website: 'https://github.com/k9-okio/blockbench-drawn-shape-tool',
	repository: 'https://github.com/k9-okio/blockbench-drawn-shape-tool',
	about: [
		'在网格上按住鼠标或手指连续画线。松开鼠标只会结束当前一笔，不会自动闭合或填充。',
		'继续画到起点即可闭合，也可以点击“闭合轮廓”手动连接当前终点与起点。',
		'视口取点：点击“在视口取点”后，把对话框挪到一边，在 3D 视口里直接点击放置顶点（吸附到网格，点已有方块时贴合表面）。2 个点生成细线，3 个点生成三角面，4 个点生成包围它们的方块。',
		'方块模式适用于所有支持立方体的 Blockbench 格式，并会合并连续区域以减少组件数量。',
		'三角形模式需要当前格式支持网格元素。Generic Model / Free Model 支持；Java Block/Item 不导出任意网格，因此只能使用方块模式。',
		'“纯三角形（3 点）”会依次使用三次点击的坐标生成一个无圆润处理的三角形；Z 尺寸为 0 时是单面，大于 0 时生成可调厚度的三角柱。',
		'混合模式用方块填充轮廓内部，并用一整块平滑三角外壳包住它们，因此外形更接近手绘线条。',
		'“圆润程度”会先圆化手绘轮廓，再把结果交给三角网格和内部方块生成。',
		'生成的元素会放进新建的“手绘形状”组，可直接撤销，也可以继续编辑、赋材质和制作动画。'
	].join('\n\n'),
	icon: 'gesture',
	variant: 'desktop',
	min_version: '5.0.0',
	version: '1.13.0',
	tags: ['Modeling', 'Tools', 'Geometry'],

	onload() {
		const GRID = 24;
		const CELL_PX = 18;
		const CANVAS_SIZE = GRID * CELL_PX;
		const EPSILON = 1e-7;

		const PLANES = {
			xy: {
				name: 'XY / 正视',
				u: [1, 0, 0],
				v: [0, 1, 0],
				n: [0, 0, 1],
				u_name: 'X',
				v_name: 'Y',
				n_name: 'Z'
			},
			xz: {
				name: 'XZ / 顶视',
				u: [1, 0, 0],
				v: [0, 0, -1],
				n: [0, 1, 0],
				u_name: 'X',
				v_name: '-Z',
				n_name: 'Y'
			},
			yz: {
				name: 'YZ / 侧视',
				u: [0, 0, -1],
				v: [0, 1, 0],
				n: [1, 0, 0],
				u_name: '-Z',
				v_name: 'Y',
				n_name: 'X'
			}
		};

		const state = {
			mode: 'cube',
			plane: 'xy',
			cell_size: 1,
			depth: 2,
			smooth: 1,
			symmetry: false,
			bend_amount: 0,
			bend_falloff: 4,
			bend_return: true,
			bend_selecting: false,
			width_factor: 1,
			width_falloff: 4,
			width_selecting: false,
			custom_default: 'cube',
			part_brush: 'cube',
			part_selecting: false,
			include_cubes: false,
			merge: true,
			snap: true,
			trimmed: false,
			origin: [0, 0, 0],
			origin_touched: false,
			point_mode: false,
			point_width: 0.5,
			point_points: [],
			points: [],
			drawing: false,
			closed: false,
			preview_cells: new Set(),
			hybrid_core: new Set(),
			bend_cells: new Set(),
			bend_columns: new Set(),
			width_cells: new Set(),
			width_columns: new Set(),
			part_cube_cells: new Set(),
			part_triangle_cells: new Set()
		};

		let dialog;
		let open_action;
		let style_node;
		let canvas;
		let canvas_context;
		let stats_node;
		let hint_node;
		let active_pointer = null;

		function clamp(value, min, max) {
			return Math.max(min, Math.min(max, value));
		}

		function round4(value) {
			return Math.round(value * 10000) / 10000;
		}

		function distance(a, b) {
			return Math.hypot(a.x - b.x, a.y - b.y);
		}

		function defaultOrigin() {
			return Format && Format.id === 'java_block' ? [8, 8, 8] : [0, 0, 0];
		}

		function createElement(tag, class_name, text) {
			const node = document.createElement(tag);
			if (class_name) node.className = class_name;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		function signedArea(points) {
			let area = 0;
			for (let i = 0; i < points.length; i++) {
				const a = points[i];
				const b = points[(i + 1) % points.length];
				area += a.x * b.y - b.x * a.y;
			}
			return area / 2;
		}

		function cross(a, b, c) {
			return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
		}

		function pointOnSegment(a, b, p, tolerance = 1e-6) {
			if (Math.abs(cross(a, b, p)) > tolerance) return false;
			return p.x >= Math.min(a.x, b.x) - tolerance &&
				p.x <= Math.max(a.x, b.x) + tolerance &&
				p.y >= Math.min(a.y, b.y) - tolerance &&
				p.y <= Math.max(a.y, b.y) + tolerance;
		}

		function segmentsIntersect(a, b, c, d) {
			const ab_c = cross(a, b, c);
			const ab_d = cross(a, b, d);
			const cd_a = cross(c, d, a);
			const cd_b = cross(c, d, b);
			if (((ab_c > EPSILON && ab_d < -EPSILON) || (ab_c < -EPSILON && ab_d > EPSILON)) &&
				((cd_a > EPSILON && cd_b < -EPSILON) || (cd_a < -EPSILON && cd_b > EPSILON))) {
				return true;
			}
			return (
				(Math.abs(ab_c) <= EPSILON && pointOnSegment(a, b, c)) ||
				(Math.abs(ab_d) <= EPSILON && pointOnSegment(a, b, d)) ||
				(Math.abs(cd_a) <= EPSILON && pointOnSegment(c, d, a)) ||
				(Math.abs(cd_b) <= EPSILON && pointOnSegment(c, d, b))
			);
		}

		function isSimplePolygon(points) {
			if (points.length < 3) return false;
			for (let i = 0; i < points.length; i++) {
				const a = points[i];
				const b = points[(i + 1) % points.length];
				for (let j = i + 1; j < points.length; j++) {
					if (j === i || j === (i + 1) % points.length) continue;
					if (i === 0 && j === points.length - 1) continue;
					const c = points[j];
					const d = points[(j + 1) % points.length];
					if (segmentsIntersect(a, b, c, d)) return false;
				}
			}
			return true;
		}

		function removeNearDuplicates(points) {
			const result = [];
			for (const point of points) {
				if (!result.length || distance(result[result.length - 1], point) > 0.055) {
					result.push({x: point.x, y: point.y});
				}
			}
			if (result.length > 2 && distance(result[0], result[result.length - 1]) < 0.12) {
				result.pop();
			}
			return result;
		}

		function removeCollinearPoints(points) {
			let result = points.slice();
			let changed = true;
			while (changed && result.length > 3) {
				changed = false;
				for (let i = 0; i < result.length; i++) {
					const previous = result[(i - 1 + result.length) % result.length];
					const current = result[i];
					const next = result[(i + 1) % result.length];
					if (Math.abs(cross(previous, current, next)) < 1e-5) {
						result.splice(i, 1);
						changed = true;
						break;
					}
				}
			}
			return result;
		}

		function cleanPolygon(points) {
			let result = removeNearDuplicates(points);
			state.trimmed = false;
			while (result.length >= 3 && !isSimplePolygon(result)) {
				result.pop();
				state.trimmed = true;
			}
			result = removeCollinearPoints(result);
			if (result.length < 3 || Math.abs(signedArea(result)) < 0.035) {
				return [];
			}
			return result;
		}

		function smoothClosedPolygon(points, iterations) {
			let result = points.map(point => ({x: point.x, y: point.y}));
			for (let iteration = 0; iteration < iterations; iteration++) {
				if (result.length < 3) break;
				const smoothed = [];
				for (let i = 0; i < result.length; i++) {
					const current = result[i];
					const next = result[(i + 1) % result.length];
					smoothed.push({
						x: current.x * 0.78 + next.x * 0.22,
						y: current.y * 0.78 + next.y * 0.22
					});
					smoothed.push({
						x: current.x * 0.22 + next.x * 0.78,
						y: current.y * 0.22 + next.y * 0.78
					});
				}
				result = removeNearDuplicates(smoothed);
			}
			result = removeCollinearPoints(result);
			return result.length >= 3 ? result : points;
		}

		function getClosedShapePolygon(points = state.points) {
			const cleaned = cleanPolygon(points);
			if (!cleaned.length || !state.smooth) return cleaned;
			return smoothClosedPolygon(cleaned, state.smooth);
		}

		function getShapePolygons(points = state.points) {
			const source = removeNearDuplicates(points);
			let base = state.mode === 'triangle_face'
				? source.slice(0, 3)
				: getClosedShapePolygon(source);
			if (!base.length) return [];
			if (!state.symmetry) return [base];

			const center = GRID / 2;
			base = base.map(point => ({
				x: Math.abs(point.x - center) < 1.1 ? center : point.x,
				y: point.y
			}));
			const mirrored = base.map(point => ({
				x: GRID - point.x,
				y: point.y
			}));
			if (mirrored.every((point, index) => Math.abs(point.x - base[index].x) < 1e-6)) {
				return [base];
			}
			return [base, mirrored];
		}

		function bendOffsetForGridColumn(column) {
			if (Math.abs(state.bend_amount) < 1e-6 || !state.bend_columns.size) return 0;
			const effective_columns = new Set(state.bend_columns);
			if (state.symmetry) {
				for (const selected_column of state.bend_columns) {
					effective_columns.add(GRID - selected_column - 1);
				}
			}
			const selected = Array.from(effective_columns).sort((a, b) => a - b);
			if (!state.bend_return) {
				const minimum = selected[0];
				const maximum = selected[selected.length - 1];
				const falloff = state.bend_falloff;
				const support_start = minimum - falloff;
				const support_end = maximum + falloff + 1;
				const t = clamp(
					(column + 0.5 - support_start) / Math.max(support_end - support_start, 1),
					0,
					1
				);
				const smooth = t * t * (3 - 2 * t);
				return state.bend_amount * smooth;
			}

			let offset = 0;
			let run_start = selected[0];
			let run_end = selected[0];

			function applyRun(start, end) {
				const falloff = state.bend_falloff;
				const support_start = start - falloff;
				const support_end = end + falloff + 1;
				if (column + 0.5 < support_start || column + 0.5 > support_end) return;
				const t = (column + 0.5 - support_start) / Math.max(support_end - support_start, 1);
				const smooth = Math.sin(Math.PI * clamp(t, 0, 1)) ** 2;
				offset += state.bend_amount * smooth;
			}

			for (let index = 1; index < selected.length; index++) {
				if (selected[index] === run_end + 1) {
					run_end = selected[index];
				} else {
					applyRun(run_start, run_end);
					run_start = run_end = selected[index];
				}
			}
			applyRun(run_start, run_end);
			return offset;
		}

		function bendOffsetForPoint(point) {
			const column = clamp(Math.floor(point.x), 0, GRID - 1);
			return bendOffsetForGridColumn(column);
		}

		function widthWarpGridX(x) {
			if (Math.abs(state.width_factor - 1) < 1e-6 || !state.width_columns.size) return x;
			const selected = new Set(state.width_columns);
			if (state.symmetry) {
				for (const column of state.width_columns) {
					selected.add(GRID - column - 1);
				}
			}
			const minimum = Math.min(...selected);
			const maximum = Math.max(...selected);
			const falloff = state.width_falloff;
			const selection_start = minimum;
			const selection_end = maximum + 1;
			const support_start = selection_start - falloff;
			const support_end = selection_end + falloff;
			if (x <= support_start || x >= support_end) return x;

			let influence = 1;
			if (x < selection_start) {
				const t = clamp((x - support_start) / falloff, 0, 1);
				influence = t * t * (3 - 2 * t);
			} else if (x > selection_end) {
				const t = clamp((support_end - x) / falloff, 0, 1);
				influence = t * t * (3 - 2 * t);
			}
			const center = (selection_start + selection_end) / 2;
			const scale = 1 + (state.width_factor - 1) * influence;
			return center + (x - center) * scale;
		}

		function pointInPolygon(point, polygon) {
			let inside = false;
			for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
				const a = polygon[i];
				const b = polygon[j];
				const intersects = ((a.y > point.y) !== (b.y > point.y)) &&
					(point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || EPSILON) + a.x);
				if (intersects) inside = !inside;
			}
			return inside;
		}

		function pointInTriangle(p, a, b, c) {
			const ab = cross(a, b, p);
			const bc = cross(b, c, p);
			const ca = cross(c, a, p);
			const has_negative = ab < -1e-8 || bc < -1e-8 || ca < -1e-8;
			const has_positive = ab > 1e-8 || bc > 1e-8 || ca > 1e-8;
			return !(has_negative && has_positive);
		}

		function triangulatePolygon(polygon) {
			if (polygon.length < 3) return [];
			const points = [];
			for (let index = 0; index < polygon.length; index++) {
				const point = polygon[index];
				const previous = points[points.length - 1];
				if (previous && distance(previous, point) < 0.045) continue;
				points.push({x: point.x, y: point.y, source_index: index});
			}
			if (points.length > 2 && distance(points[0], points[points.length - 1]) < 0.045) {
				points.pop();
			}
			if (points.length < 3) return [];
			if (signedArea(points) < 0) points.reverse();

			try {
				const contour = points.map(point => new THREE.Vector2(point.x, point.y));
				const built_in = THREE.ShapeUtils.triangulateShape(contour, []);
				if (built_in && built_in.length) {
					return built_in
						.filter(triangle => triangle.length === 3)
						.map(triangle => triangle.map(index => points[index].source_index));
				}
			} catch (error) {
				console.warn('Drawn Shape Tool: built-in triangulation failed, using fallback', error);
			}

			const indices = points.map((_, index) => index);
			const triangles = [];
			let guard = 0;

			while (indices.length > 3 && guard++ < points.length * points.length) {
				let ear_found = false;
				for (let i = 0; i < indices.length; i++) {
					const ia = indices[(i - 1 + indices.length) % indices.length];
					const ib = indices[i];
					const ic = indices[(i + 1) % indices.length];
					const a = points[ia];
					const b = points[ib];
					const c = points[ic];

					if (cross(a, b, c) <= 1e-8) continue;

					let contains_point = false;
					for (const index of indices) {
						if (index === ia || index === ib || index === ic) continue;
						if (pointInTriangle(points[index], a, b, c)) {
							contains_point = true;
							break;
						}
					}
					if (contains_point) continue;

					triangles.push([ia, ib, ic]);
					indices.splice(i, 1);
					ear_found = true;
					break;
				}
				if (!ear_found) return [];
			}

			if (indices.length === 3) {
				triangles.push(indices.slice());
			}
			return triangles.map(triangle =>
				triangle.map(index => points[index].source_index)
			);
		}

		function fillCells(polygon) {
			const cells = new Set();
			if (polygon.length < 3) return cells;
			for (let row = 0; row < GRID; row++) {
				for (let column = 0; column < GRID; column++) {
					if (pointInPolygon({x: column + 0.5, y: row + 0.5}, polygon)) {
						cells.add(`${column},${row}`);
					}
				}
			}
			return cells;
		}

		function fillCellsForPolygons(polygons) {
			const cells = new Set();
			for (const polygon of polygons) {
				for (const key of fillCells(polygon)) cells.add(key);
			}
			return cells;
		}

		function clipPolygonToCell(polygon, column, row) {
			const min_x = column;
			const max_x = column + 1;
			const min_y = row;
			const max_y = row + 1;

			function clipAgainstEdge(points, inside, intersect) {
				if (!points.length) return [];
				const result = [];
				for (let i = 0; i < points.length; i++) {
					const current = points[i];
					const previous = points[(i - 1 + points.length) % points.length];
					const current_inside = inside(current);
					const previous_inside = inside(previous);
					if (current_inside) {
						if (!previous_inside) result.push(intersect(previous, current));
						result.push({x: current.x, y: current.y});
					} else if (previous_inside) {
						result.push(intersect(previous, current));
					}
				}
				return removeNearDuplicates(result);
			}

			function verticalIntersection(a, b, x) {
				const t = (x - a.x) / ((b.x - a.x) || EPSILON);
				return {x, y: a.y + (b.y - a.y) * t};
			}

			function horizontalIntersection(a, b, y) {
				const t = (y - a.y) / ((b.y - a.y) || EPSILON);
				return {x: a.x + (b.x - a.x) * t, y};
			}

			let clipped = polygon.map(point => ({x: point.x, y: point.y}));
			clipped = clipAgainstEdge(clipped, point => point.x >= min_x, (a, b) => verticalIntersection(a, b, min_x));
			clipped = clipAgainstEdge(clipped, point => point.x <= max_x, (a, b) => verticalIntersection(a, b, max_x));
			clipped = clipAgainstEdge(clipped, point => point.y >= min_y, (a, b) => horizontalIntersection(a, b, min_y));
			clipped = clipAgainstEdge(clipped, point => point.y <= max_y, (a, b) => horizontalIntersection(a, b, max_y));
			return removeNearDuplicates(clipped);
		}

		function scanHybridCells(polygons) {
			const all_cells = new Set();
			const core_cells = new Set();
			const sources = Array.isArray(polygons) ? polygons : [polygons];
			if (!sources.some(polygon => polygon.length >= 3)) return {all_cells, core_cells};

			for (const polygon of sources) {
				if (polygon.length < 3) continue;
				for (let row = 0; row < GRID; row++) {
					for (let column = 0; column < GRID; column++) {
						const clipped = clipPolygonToCell(polygon, column, row);
						const area = Math.abs(signedArea(clipped));
						if (clipped.length < 3 || area < 1e-5) continue;
						all_cells.add(`${column},${row}`);
						if (area > 1 - 1e-5) {
							core_cells.add(`${column},${row}`);
						}
					}
				}
			}
			return {all_cells, core_cells};
		}

		function parseCell(key) {
			const parts = key.split(',');
			return [parseInt(parts[0]), parseInt(parts[1])];
		}

		function bestRectangle(column, row, remaining) {
			let max_width = 0;
			while (column + max_width < GRID && remaining.has(`${column + max_width},${row}`)) {
				max_width++;
			}
			let best = {width: 0, height: 0, area: 0};
			for (let width = max_width; width >= 1; width--) {
				let height = 0;
				height_loop:
				while (row + height < GRID) {
					for (let x = column; x < column + width; x++) {
						if (!remaining.has(`${x},${row + height}`)) break height_loop;
					}
					height++;
				}
				const area = width * height;
				if (area > best.area) best = {width, height, area};
			}
			return best;
		}

		function mergeCells(cells) {
			const rectangles = [];
			const remaining = new Set(cells);
			const ordered = Array.from(cells)
				.map(parseCell)
				.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));

			for (const [column, row] of ordered) {
				const key = `${column},${row}`;
				if (!remaining.has(key)) continue;
				const rectangle = bestRectangle(column, row, remaining);
				if (!rectangle.area) continue;
				for (let y = row; y < row + rectangle.height; y++) {
					for (let x = column; x < column + rectangle.width; x++) {
						remaining.delete(`${x},${y}`);
					}
				}
				rectangles.push({
					column,
					row,
					width: rectangle.width,
					height: rectangle.height
				});
			}
			return rectangles;
		}

		function mergeCellsByColumn(cells) {
			const by_column = new Map();
			for (const key of cells) {
				const [column, row] = parseCell(key);
				if (!by_column.has(column)) by_column.set(column, []);
				by_column.get(column).push(row);
			}
			const rectangles = [];
			for (const [column, rows] of by_column) {
				rows.sort((a, b) => a - b);
				let start = rows[0];
				let previous = start;
				for (let i = 1; i <= rows.length; i++) {
					const row = rows[i];
					if (row !== previous + 1) {
						rectangles.push({
							column,
							row: start,
							width: 1,
							height: previous - start + 1
						});
						start = row;
					}
					previous = row;
				}
			}
			return rectangles;
		}

		function traceCellRegionBoundaries(cells) {
			const edges = new Map();
			const addEdge = (a, b) => {
				if (!edges.has(a)) edges.set(a, []);
				edges.get(a).push(b);
			};

			for (const key of cells) {
				const [column, row] = parseCell(key);
				const x0 = column;
				const y0 = row;
				const x1 = column + 1;
				const y1 = row + 1;
				if (!cells.has(`${column},${row - 1}`)) addEdge(`${x0},${y0}`, `${x1},${y0}`);
				if (!cells.has(`${column + 1},${row}`)) addEdge(`${x1},${y0}`, `${x1},${y1}`);
				if (!cells.has(`${column},${row + 1}`)) addEdge(`${x1},${y1}`, `${x0},${y1}`);
				if (!cells.has(`${column - 1},${row}`)) addEdge(`${x0},${y1}`, `${x0},${y0}`);
			}

			const boundaries = [];
			while (edges.size) {
				const start = edges.keys().next().value;
				const points = [];
				let current = start;
				let guard = 0;
				while (current && guard++ < cells.size * 8) {
					const next_list = edges.get(current);
					if (!next_list || !next_list.length) break;
					const next = next_list.shift();
					if (!next_list.length) edges.delete(current);
					points.push({
						x: parseFloat(current.split(',')[0]),
						y: parseFloat(current.split(',')[1])
					});
					if (next === start) break;
					current = next;
				}
				const boundary = removeCollinearPoints(points);
				if (boundary.length >= 3 && Math.abs(signedArea(boundary)) > 1e-5) {
					boundaries.push(boundary);
				}
			}
			return boundaries;
		}

		function planePosition(u, v, normal, plane = PLANES[state.plane], origin = state.origin) {
			return [
				round4(origin[0] + plane.u[0] * u + plane.v[0] * v + plane.n[0] * normal),
				round4(origin[1] + plane.u[1] * u + plane.v[1] * v + plane.n[1] * normal),
				round4(origin[2] + plane.u[2] * u + plane.v[2] * v + plane.n[2] * normal)
			];
		}

		function pointToModel(point, normal) {
			const u = (widthWarpGridX(point.x) - GRID / 2) * state.cell_size;
			const v = (point.y - GRID / 2) * state.cell_size;
			return planePosition(u, v, normal + bendOffsetForPoint(point));
		}

		function gridToModel(column, row, normal) {
			const u = (widthWarpGridX(column) - GRID / 2) * state.cell_size;
			const v = (row - GRID / 2) * state.cell_size;
			return planePosition(u, v, normal + bendOffsetForGridColumn(clamp(column, 0, GRID - 1)));
		}

		function boundsFromPoints(points) {
			const from = [Infinity, Infinity, Infinity];
			const to = [-Infinity, -Infinity, -Infinity];
			for (const point of points) {
				for (let axis = 0; axis < 3; axis++) {
					from[axis] = Math.min(from[axis], point[axis]);
					to[axis] = Math.max(to[axis], point[axis]);
				}
			}
			return {
				from: from.map(round4),
				to: to.map(round4)
			};
		}

		function applyDefaultTexture(element) {
			if (!Texture.all.length) return;
			const texture = Texture.getDefault();
			if (!texture) return;
			try {
				element.applyTexture(texture, true);
			} catch (error) {
				console.warn('Drawn Shape Tool: could not apply texture', error);
			}
		}

		function createGroup(name) {
			const group = new Group({name}).init();
			if (group.getTypeBehavior('unique_name')) group.createUniqueName();
			return group;
		}

		function rebaseGeneratedGroup(group, elements) {
			const points = [];
			for (const element of elements) {
				if (element instanceof Cube) {
					points.push(element.from, element.to);
				} else if (element instanceof Mesh) {
					points.push(...Object.values(element.vertices));
				}
			}
			if (!points.length) return [0, 0, 0];

			const minimum = [Infinity, Infinity, Infinity];
			const maximum = [-Infinity, -Infinity, -Infinity];
			for (const point of points) {
				for (let axis = 0; axis < 3; axis++) {
					minimum[axis] = Math.min(minimum[axis], point[axis]);
					maximum[axis] = Math.max(maximum[axis], point[axis]);
				}
			}
			const center = [0, 1, 2].map(axis => (minimum[axis] + maximum[axis]) / 2);
			center.forEach((value, axis) => center[axis] = round4(value));

			group.origin.V3_set(center);
			try {
				group.preview_controller.updateTransform(group);
			} catch (error) {
				console.warn('Drawn Shape Tool: could not update group pivot', error);
			}
			return center;
		}

		function createCubeShape(group, cells, normal_start = 0, normal_end = state.depth) {
			const bend_active = Math.abs(state.bend_amount) >= 1e-6 && state.bend_columns.size > 0;
			const rectangles = bend_active
				? mergeCellsByColumn(cells)
				: state.merge ? mergeCells(cells) : Array.from(cells).map(key => {
				const [column, row] = parseCell(key);
				return {column, row, width: 1, height: 1};
				});
			const cubes = [];

			for (const rectangle of rectangles) {
				const corners = [
					gridToModel(rectangle.column, rectangle.row, normal_start),
					gridToModel(rectangle.column + rectangle.width, rectangle.row + rectangle.height, normal_start),
					gridToModel(rectangle.column, rectangle.row, normal_end),
					gridToModel(rectangle.column + rectangle.width, rectangle.row + rectangle.height, normal_end)
				];
				const bounds = boundsFromPoints(corners);
				const cube = new Cube({
					name: 'drawn_cube',
					from: bounds.from,
					to: bounds.to,
					autouv: 1
				});
				cube.init();
				cube.addTo(group);
				if (!cube.box_uv) cube.mapAutoUV();
				applyDefaultTexture(cube);
				cubes.push(cube);
			}
			return cubes;
		}

		function appendTrianglePrism(mesh, source_polygon, options = {}) {
			const polygon = source_polygon.map(point => ({x: point.x, y: point.y}));
			if (signedArea(polygon) < 0) polygon.reverse();
			const triangles = triangulatePolygon(polygon);
			if (!triangles.length) return 0;
			const depth = options.depth !== undefined ? options.depth : state.depth;
			const rounded = options.rounded !== false;

			const uv_width = Project.texture_width || 16;
			const uv_height = Project.texture_height || 16;
			const bevel = rounded && state.smooth
				? Math.min(depth * 0.22, state.cell_size * 0.12 * state.smooth)
				: 0;
			const inset_ratio = rounded && state.smooth
				? Math.min(0.24, 0.045 * state.smooth + 0.025)
				: 0;
			const center = polygon.reduce((sum, point) => {
				sum.x += point.x / polygon.length;
				sum.y += point.y / polygon.length;
				return sum;
			}, {x: 0, y: 0});
			const inset_polygon = polygon.map(point => ({
				x: point.x + (center.x - point.x) * inset_ratio,
				y: point.y + (center.y - point.y) * inset_ratio
			}));
			const rings = bevel > 1e-5
				? [
					{points: inset_polygon, normal: 0},
					{points: polygon, normal: bevel},
					{points: polygon, normal: depth - bevel},
					{points: inset_polygon, normal: depth}
				]
				: [
					{points: polygon, normal: 0},
					{points: polygon, normal: depth}
				];

			for (const ring of rings) {
				ring.keys = [];
				ring.uvs = [];
				for (const point of ring.points) {
					ring.keys.push(mesh.addVertices(pointToModel(point, ring.normal))[0]);
					ring.uvs.push([
						round4(point.x / GRID * uv_width),
						round4((GRID - point.y) / GRID * uv_height)
					]);
				}
			}

			const side_uv = [
				[0, 0],
				[uv_width, 0],
				[uv_width, uv_height]
			];

			function addTriFace(keys, uvs) {
				const uv = {};
				keys.forEach((key, index) => {
					uv[key] = uvs ? uvs[index].slice() : [0, 0];
				});
				mesh.addFaces(new MeshFace(mesh, {vertices: keys, uv}));
			}

			const front_ring = rings[0];
			const back_ring = rings[rings.length - 1];
			let cap_face_count = 0;

			function addCellCaps(cap_polygon, normal, reverse = false) {
				for (let row = 0; row < GRID; row++) {
					for (let column = 0; column < GRID; column++) {
						const clipped = clipPolygonToCell(cap_polygon, column, row);
						const cell_triangles = triangulatePolygon(clipped);
						for (const triangle of cell_triangles) {
							let ordered = triangle.slice();
							if (reverse) ordered.reverse();
							const keys = [];
							const uvs = [];
							for (const index of ordered) {
								const point = clipped[index];
								keys.push(mesh.addVertices(pointToModel(point, normal))[0]);
								uvs.push([
									round4(point.x / GRID * uv_width),
									round4((GRID - point.y) / GRID * uv_height)
								]);
							}
							addTriFace(keys, uvs);
							cap_face_count++;
						}
					}
				}
			}

			if (options.cell_caps) {
				addCellCaps(front_ring.points, 0, false);
				addCellCaps(back_ring.points, depth, true);
			} else {
				for (const triangle of triangles) {
					const front_face = triangle.map(index => front_ring.keys[index]);
					addTriFace(front_face, triangle.map(index => front_ring.uvs[index]));
					cap_face_count++;

					const reversed_triangle = triangle.slice().reverse();
					const back_face = reversed_triangle.map(index => back_ring.keys[index]);
					const back_uv = reversed_triangle.map(index => back_ring.uvs[index]);
					addTriFace(back_face, back_uv);
					cap_face_count++;
				}
			}

			for (let ring_index = 0; ring_index < rings.length - 1; ring_index++) {
				const first_ring = rings[ring_index];
				const second_ring = rings[ring_index + 1];
				for (let i = 0; i < polygon.length; i++) {
					const next = (i + 1) % polygon.length;
					const a = first_ring.keys[i];
					const b = first_ring.keys[next];
					const c = second_ring.keys[next];
					const d = second_ring.keys[i];
					addTriFace([a, b, c], [side_uv[0], side_uv[1], side_uv[2]]);
					addTriFace([a, c, d], [side_uv[0], side_uv[2], side_uv[1]]);
				}
			}
			return cap_face_count + (rings.length - 1) * polygon.length * 2;
		}

		function mirrorMeshGeometry(mesh) {
			const mirrored_keys = {};
			for (const key of Object.keys(mesh.vertices)) {
				const vertex = mesh.vertices[key];
				mirrored_keys[key] = mesh.addVertices([-vertex[0], vertex[1], vertex[2]])[0];
			}
			const source_faces = Object.values(mesh.faces).slice();
			for (const face of source_faces) {
				const keys = face.vertices.map(key => mirrored_keys[key]).reverse();
				const uv = {};
				face.vertices.forEach(key => {
					uv[mirrored_keys[key]] = face.uv[key] ? face.uv[key].slice() : [0, 0];
				});
				mesh.addFaces(new MeshFace(mesh, {vertices: keys, uv}));
			}
			return source_faces.length;
		}

		function createTriangleMesh(group, polygons, name) {
			const mesh = new Mesh({
				name,
				vertices: {},
				faces: {},
				seams: {},
				color: 0
			});
			let face_count = 0;
			const mirror = state.symmetry && polygons.length > 1;
			const source_polygons = mirror ? [polygons[0]] : polygons;
			for (const polygon of source_polygons) {
				face_count += appendTrianglePrism(mesh, polygon, {cell_caps: true});
			}
			if (mirror) face_count += mirrorMeshGeometry(mesh);
			if (!face_count) {
				throw new Error('无法三角化这个轮廓，请重画一个更简单的闭合形状。');
			}
			mesh.init();
			mesh.addTo(group);
			applyDefaultTexture(mesh);
			return mesh;
		}

		function createTriangleShape(group, polygons) {
			return createTriangleMesh(group, polygons, 'drawn_triangles');
		}

		function createPureTriangle(group, polygons) {
			const mesh = new Mesh({
				name: 'pure_triangle',
				vertices: {},
				faces: {},
				seams: {},
				color: 0
			});
			let face_count = 0;
			const mirror = state.symmetry && polygons.length > 1;
			const source_polygons = mirror ? [polygons[0]] : polygons;
			for (const polygon of source_polygons) {
				if (polygon.length !== 3 || Math.abs(signedArea(polygon)) < 1e-5) {
					throw new Error('纯三角面需要三个不共线的角点。');
				}
				const triangle = polygon.map(point => ({x: point.x, y: point.y}));
				if (signedArea(triangle) < 0) triangle.reverse();
				if (state.depth > 1e-5) {
					face_count += appendTrianglePrism(mesh, triangle, {
						depth: state.depth,
						rounded: false
					});
				} else {
					const keys = mesh.addVertices(
						...triangle.map(point => pointToModel(point, 0))
					);
					const uv_width = Project.texture_width || 16;
					const uv_height = Project.texture_height || 16;
					const uv = {};
					keys.forEach((key, index) => {
						const point = triangle[index];
						uv[key] = [
							round4(point.x / GRID * uv_width),
							round4((GRID - point.y) / GRID * uv_height)
						];
					});
					mesh.addFaces(new MeshFace(mesh, {vertices: keys, uv}));
					face_count++;
				}
			}
			if (mirror) face_count += mirrorMeshGeometry(mesh);
			if (!face_count) throw new Error('没有生成纯三角形。');
			mesh.init();
			mesh.addTo(group);
			mesh.shading = 'flat';
			applyDefaultTexture(mesh);
			return mesh;
		}

		function createHybridShape(group, polygons) {
			const inset = Math.min(0.05, state.depth * 0.05);
			const normal_end = Math.max(inset + 0.001, state.depth - inset);
			const cubes = state.include_cubes
				? createCubeShape(group, state.hybrid_core, inset, normal_end)
				: [];
			const mesh = createTriangleMesh(group, polygons, 'drawn_smooth_shell');
			return {cubes, mesh};
		}

		function getCustomPartCells() {
			const cube_cells = new Set();
			const triangle_cells = new Set();
			for (const key of state.preview_cells) {
				if (state.part_triangle_cells.has(key)) {
					triangle_cells.add(key);
				} else if (state.part_cube_cells.has(key)) {
					cube_cells.add(key);
				} else if (state.custom_default === 'triangle') {
					triangle_cells.add(key);
				} else {
					cube_cells.add(key);
				}
			}
			return {cube_cells, triangle_cells};
		}

		function createCellTriangleMesh(group, polygons, cells) {
			const mesh = new Mesh({
				name: 'custom_triangle_parts',
				vertices: {},
				faces: {},
				seams: {},
				color: 0
			});
			const mirror = state.symmetry;
			const source_cells = mirror
				? Array.from(cells).filter(key => parseCell(key)[0] >= GRID / 2)
				: Array.from(cells);
			let face_count = 0;
			const region_boundaries = traceCellRegionBoundaries(new Set(source_cells));
			for (const boundary of region_boundaries) {
				face_count += appendTrianglePrism(mesh, boundary, {
					depth: state.depth,
					rounded: false,
					cell_caps: false
				});
			}
			if (mirror && face_count) face_count += mirrorMeshGeometry(mesh);
			if (!face_count) return null;
			mesh.init();
			mesh.addTo(group);
			mesh.shading = 'flat';
			applyDefaultTexture(mesh);
			return mesh;
		}

		function createCustomMixShape(group, polygons) {
			const parts = getCustomPartCells();
			const cubes = createCubeShape(group, parts.cube_cells);
			const mesh = parts.triangle_cells.size
				? createCellTriangleMesh(group, polygons, parts.triangle_cells)
				: null;
			return {cubes, mesh, parts};
		}

		// ---- 视口取点：2 点连线 / 3 点成面 / 4 点成方块 ----
		let point_overlay = null;
		let point_overlay_frame = 0;
		let point_pointer_listener = null;
		let point_bar = null;

		function activePreview() {
			try {
				return Blockbench.Preview && Blockbench.Preview.selected
					? Blockbench.Preview.selected
					: null;
			} catch (error) {
				return null;
			}
		}

		function snapModelPoint(vector) {
			const cell = state.cell_size || 1;
			return vector.map(value => round4(Math.round(value / cell) * cell));
		}

		function previewPlanePoint(preview, event) {
			if (!preview || !preview.canvas || !preview.camera) return null;
			const plane = PLANES[state.plane] || PLANES.xy;
			const normal = new THREE.Vector3(plane.n[0], plane.n[1], plane.n[2]);
			const point_on_plane = new THREE.Vector3(
				state.origin[0] + plane.n[0] * state.depth,
				state.origin[1] + plane.n[1] * state.depth,
				state.origin[2] + plane.n[2] * state.depth
			);
			const math_plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point_on_plane);
			const rect = preview.canvas.getBoundingClientRect();
			if (!rect.width || !rect.height) return null;
			const ndc = new THREE.Vector2(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				-((event.clientY - rect.top) / rect.height) * 2 + 1
			);
			const raycaster = new THREE.Raycaster();
			raycaster.setFromCamera(ndc, preview.camera);
			const hit = new THREE.Vector3();
			return raycaster.ray.intersectPlane(math_plane, hit) ? hit : null;
		}

		function pickViewportPoint(event) {
			const preview = activePreview();
			if (!preview || !preview.canvas) return null;
			let hit = null;
			try {
				const data = preview.raycast(event);
				if (data && data.intersects && data.intersects.length) {
					hit = data.intersects[0].point.clone();
				}
			} catch (error) {
				console.warn('Drawn Shape Tool: viewport raycast failed', error);
			}
			if (!hit) hit = previewPlanePoint(preview, event);
			return hit ? snapModelPoint(hit.toArray()) : null;
		}

		function ensureOverlayCanvas() {
			if (!point_overlay) {
				point_overlay = document.createElement('canvas');
				point_overlay.id = 'dst_point_overlay';
				point_overlay.style.position = 'fixed';
				point_overlay.style.pointerEvents = 'none';
				point_overlay.style.zIndex = '70';
				document.body.append(point_overlay);
			}
			return point_overlay;
		}

		function drawPointOverlay() {
			point_overlay_frame = 0;
			if (!state.point_mode) {
				if (point_overlay) point_overlay.style.display = 'none';
				return;
			}
			point_overlay_frame = requestAnimationFrame(drawPointOverlay);
			const preview = activePreview();
			const overlay = ensureOverlayCanvas();
			if (!preview || !preview.canvas || !preview.canvas.isConnected || !preview.camera) {
				overlay.style.display = 'none';
				return;
			}
			const rect = preview.canvas.getBoundingClientRect();
			const width = Math.max(1, Math.round(rect.width));
			const height = Math.max(1, Math.round(rect.height));
			const dpr = window.devicePixelRatio || 1;
			if (overlay.width !== Math.round(width * dpr) || overlay.height !== Math.round(height * dpr)) {
				overlay.width = Math.round(width * dpr);
				overlay.height = Math.round(height * dpr);
			}
			overlay.style.display = 'block';
			overlay.style.left = `${rect.left}px`;
			overlay.style.top = `${rect.top}px`;
			overlay.style.width = `${width}px`;
			overlay.style.height = `${height}px`;
			const ctx = overlay.getContext('2d');
			if (!ctx) return;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, width, height);
			const projected = state.point_points.map(point => {
				const vector = new THREE.Vector3(point[0], point[1], point[2]).project(preview.camera);
				return {
					x: (vector.x * 0.5 + 0.5) * width,
					y: (-vector.y * 0.5 + 0.5) * height,
					visible: vector.z <= 1
				};
			});
			ctx.lineWidth = 2;
			ctx.strokeStyle = 'rgba(255, 210, 74, 0.95)';
			ctx.beginPath();
			projected.forEach((point, index) => {
				if (index === 0) ctx.moveTo(point.x, point.y);
				else ctx.lineTo(point.x, point.y);
			});
			ctx.stroke();
			projected.forEach((point, index) => {
				if (!point.visible) return;
				ctx.beginPath();
				ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
				ctx.fillStyle = '#ffd24a';
				ctx.fill();
				ctx.lineWidth = 2;
				ctx.strokeStyle = '#4a3200';
				ctx.stroke();
				ctx.fillStyle = '#2b1c00';
				ctx.font = 'bold 11px sans-serif';
				ctx.fillText(String(index + 1), point.x + 9, point.y - 8);
			});
		}

		function onViewportPointerDown(event) {
			if (!state.point_mode || event.button !== 0) return;
			const preview = activePreview();
			if (!preview || !preview.canvas || event.target !== preview.canvas) return;
			const point = pickViewportPoint(event);
			if (!point) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.stopImmediatePropagation) event.stopImmediatePropagation();
			state.point_points.push(point);
			updatePointPanel();
			if (state.point_points.length >= 4) {
				createPointShape(true);
			}
		}

		function ensurePointBar() {
			if (point_bar) return point_bar;
			point_bar = createElement('div', 'dst_point_bar');
			point_bar.dataset.open = 'false';
			const title = createElement('div', 'dst_point_bar_title', '取点模式：2 点线 / 3 点面 / 4 点方块');
			const make = createElement('button', '', '生成');
			make.type = 'button';
			const undo = createElement('button', '', '撤销');
			undo.type = 'button';
			const clear = createElement('button', '', '清空');
			clear.type = 'button';
			const back = createElement('button', '', '返回面板');
			back.type = 'button';
			const info = createElement('div', 'dst_point_bar_info', '');
			info.id = 'dst_point_bar_info';
			make.addEventListener('click', () => createPointShape(false));
			undo.addEventListener('click', () => {
				if (state.point_points.length) state.point_points.pop();
				updatePointPanel();
			});
			clear.addEventListener('click', () => {
				state.point_points = [];
				updatePointPanel();
			});
			back.addEventListener('click', () => {
				stopPointMode(false);
				if (dialog) dialog.show();
			});
			point_bar.append(title, make, undo, clear, back, info);
			document.body.append(point_bar);
			return point_bar;
		}

		function startPointMode() {
			if (!Project || !Format) {
				Blockbench.showMessageBox({
					title: '视口取点',
					message: '请先打开或新建一个模型项目。',
					icon: 'info'
				});
				return;
			}
			if (state.point_mode) return;
			syncStateFromInputs();
			state.point_mode = true;
			state.point_points = [];
			ensureOverlayCanvas();
			ensurePointBar();
			if (dialog) dialog.hide();
			point_bar.dataset.open = 'true';
			if (!point_pointer_listener) {
				point_pointer_listener = event => onViewportPointerDown(event);
			}
			document.addEventListener('pointerdown', point_pointer_listener, true);
			updatePointPanel();
			if (!point_overlay_frame) drawPointOverlay();
		}

		function stopPointMode(keep_points) {
			state.point_mode = false;
			if (point_pointer_listener) {
				document.removeEventListener('pointerdown', point_pointer_listener, true);
			}
			if (point_overlay_frame) {
				cancelAnimationFrame(point_overlay_frame);
				point_overlay_frame = 0;
			}
			if (point_overlay) point_overlay.style.display = 'none';
			if (point_bar) point_bar.dataset.open = 'false';
			if (!keep_points) state.point_points = [];
			updatePointPanel();
		}

		function updatePointPanel() {
			const bar_info = point_bar ? point_bar.querySelector('#dst_point_bar_info') : null;
			const points = state.point_points.map(
				(point, index) => `P${index + 1}(${point.join(', ')})`
			);
			const summary = points.length
				? `${points.join('  ')}　${state.point_points.length === 2
					? '再放 1 或 2 个点，或点“生成”'
					: '再放 1 个点自动生成方块，或点“生成”'}`
				: state.point_mode
					? '在 3D 视口点击放置第 1 个点（自动吸附网格；点已有方块会贴到表面）'
					: '点击“在视口取点”后，本面板会暂时收起，直接在 3D 视口里点击放点';
			if (bar_info) bar_info.textContent = summary;
			if (!dialog || !dialog.object) return;
			const button = dialog.object.querySelector('#dst_point_toggle');
			if (button) {
				button.textContent = state.point_mode ? '正在视口取点…' : '在视口取点';
				button.dataset.active = state.point_mode ? 'true' : 'false';
			}
			const info = dialog.object.querySelector('#dst_point_info');
			if (info) info.textContent = summary;
		}

		function createLineCube(group, a, b) {
			const width = Math.max(0.0625, state.point_width || 0.5);
			const from = [];
			const to = [];
			for (let axis = 0; axis < 3; axis++) {
				let low = Math.min(a[axis], b[axis]);
				let high = Math.max(a[axis], b[axis]);
				if (high - low < width) {
					const center = (low + high) / 2;
					low = center - width / 2;
					high = center + width / 2;
				}
				from.push(round4(low));
				to.push(round4(high));
			}
			const cube = new Cube({
				name: 'point_line',
				from,
				to,
				autouv: 1
			});
			cube.init();
			cube.addTo(group);
			if (!cube.box_uv) cube.mapAutoUV();
			applyDefaultTexture(cube);
			return cube;
		}

		function createFaceMesh(group, points) {
			const mesh = new Mesh({
				name: 'point_face',
				vertices: {},
				faces: {},
				seams: {},
				color: 0
			});
			const keys = mesh.addVertices(...points.map(point => point.slice()));
			const minimum = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])));
			const maximum = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])));
			const uv_width = Project.texture_width || 16;
			const uv_height = Project.texture_height || 16;
			const uv = {};
			keys.forEach((key, index) => {
				const point = points[index];
				uv[key] = [
					round4((point[0] - minimum[0]) / (maximum[0] - minimum[0] || 1) * uv_width),
					round4((1 - (point[1] - minimum[1]) / (maximum[1] - minimum[1] || 1)) * uv_height)
				];
			});
			mesh.addFaces(new MeshFace(mesh, {vertices: keys, uv}));
			mesh.addFaces(new MeshFace(mesh, {vertices: keys.slice().reverse(), uv}));
			mesh.init();
			mesh.addTo(group);
			mesh.shading = 'flat';
			applyDefaultTexture(mesh);
			return mesh;
		}

		function createBoxCube(group, points) {
			const minimum_size = Math.max(0.0625, state.point_width || 0.5);
			const from = [];
			const to = [];
			for (let axis = 0; axis < 3; axis++) {
				let low = Math.min(...points.map(point => point[axis]));
				let high = Math.max(...points.map(point => point[axis]));
				if (high - low < minimum_size) {
					const center = (low + high) / 2;
					low = center - minimum_size / 2;
					high = center + minimum_size / 2;
				}
				from.push(round4(low));
				to.push(round4(high));
			}
			const cube = new Cube({
				name: 'point_box',
				from,
				to,
				autouv: 1
			});
			cube.init();
			cube.addTo(group);
			if (!cube.box_uv) cube.mapAutoUV();
			applyDefaultTexture(cube);
			return cube;
		}

		function createPointShape(automatic) {
			if (!Project || !Format) {
				Blockbench.showMessageBox({
					title: '视口取点',
					message: '请先打开或新建一个模型项目。',
					icon: 'info'
				});
				return false;
			}
			syncStateFromInputs();
			const points = state.point_points.slice();
			if (points.length < 2) {
				Blockbench.showMessageBox({
					title: '点不够',
					message: '至少需要在 3D 视口里放置 2 个点：2 点连线、3 点成面、4 点成方块。',
					icon: 'info'
				});
				return false;
			}
			if (points.length === 3 && !Format.meshes) {
				Blockbench.showMessageBox({
					title: '当前格式不支持三角形网格',
					message: 'Java Block/Item 不能导出任意三角面。请再放一个点生成方块，或改用 Generic Model / Free Model。',
					icon: 'info'
				});
				return false;
			}

			const created_elements = [];
			const created_groups = [];
			Undo.initEdit({elements: [], groups: [], outliner: true, selection: true});
			try {
				const group = createGroup(makeShapeName('point_shape'));
				created_groups.push(group);
				if (points.length === 2) {
					created_elements.push(createLineCube(group, points[0], points[1]));
				} else if (points.length === 3) {
					created_elements.push(createFaceMesh(group, points));
				} else {
					created_elements.push(createBoxCube(group, points));
				}
				const group_origin = rebaseGeneratedGroup(group, created_elements);
				try {
					unselectAllElements();
					group.select();
					if (Texture.all.length) UVEditor.loadData();
				} catch (selection_error) {
					console.warn('Drawn Shape Tool: selection refresh failed', selection_error);
				}
				Undo.finishEdit('生成取点形状', {
					elements: created_elements,
					groups: created_groups,
					outliner: true,
					selection: true
				});
				try {
					Canvas.updateAll();
				} catch (canvas_error) {
					Canvas.updateView({
						elements: created_elements,
						element_aspects: {geometry: true, transform: true, uv: true}
					});
				}
				Blockbench.dispatchEvent('add_drawn_shape', {
					elements: created_elements,
					group: group,
					mode: 'point',
					plane: state.plane,
					position: group_origin
				});
				Blockbench.showQuickMessage(
					points.length === 2
						? '已按 2 个点生成线段'
						: points.length === 3
							? '已按 3 个点生成三角面'
							: '已按 4 个点生成方块'
				);
				state.point_points = [];
				updatePointPanel();
				return true;
			} catch (error) {
				console.error('Drawn Shape Tool:', error);
				try {
					Undo.cancelEdit();
				} catch (cancel_error) {
					console.warn('Drawn Shape Tool: Undo cancel failed', cancel_error);
				}
				Blockbench.showMessageBox({
					title: '生成失败',
					message: error && error.message ? error.message : String(error),
					icon: 'error'
				});
				return false;
			}
		}

		function makeShapeName(prefix) {
			const now = new Date();
			const pad = value => String(value).padStart(2, '0');
			return `${prefix}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		}

		function updatePreview() {
			const path = removeNearDuplicates(state.points);
			const polygons = state.closed ? getShapePolygons(path) : [];
			state.hybrid_core = new Set();
			if (!state.closed) {
				state.preview_cells = new Set();
			} else if (state.mode === 'hybrid') {
				const hybrid = scanHybridCells(polygons);
				state.preview_cells = hybrid.all_cells;
				state.hybrid_core = hybrid.core_cells;
			} else {
				state.preview_cells = fillCellsForPolygons(polygons);
			}
			renderCanvas(path, polygons);
			updateStats(state.closed ? polygons : [path]);
		}

		function renderCanvas(path, polygons) {
			if (!canvas || !canvas_context) return;
			const ctx = canvas_context;
			const dpr = window.devicePixelRatio || 1;
			const bitmap_size = Math.round(CANVAS_SIZE * dpr);
			if (canvas.width !== bitmap_size || canvas.height !== bitmap_size) {
				canvas.width = bitmap_size;
				canvas.height = bitmap_size;
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

			ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
			ctx.fillStyle = '#18202b';
			ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

			ctx.fillStyle = 'rgba(83, 203, 255, 0.38)';
			for (const key of state.preview_cells) {
				const [column, row] = parseCell(key);
				ctx.fillRect(
					column * CELL_PX + 1,
					(GRID - row - 1) * CELL_PX + 1,
					CELL_PX - 2,
					CELL_PX - 2
				);
			}
			ctx.fillStyle = 'rgba(255, 170, 70, 0.48)';
			const bend_cells_to_draw = new Set(state.bend_cells);
			if (state.symmetry) {
				for (const key of state.bend_cells) {
					const [column, row] = parseCell(key);
					bend_cells_to_draw.add(`${GRID - column - 1},${row}`);
				}
			}
			for (const key of bend_cells_to_draw) {
				const [column, row] = parseCell(key);
				ctx.fillRect(
					column * CELL_PX + 2,
					(GRID - row - 1) * CELL_PX + 2,
					CELL_PX - 4,
					CELL_PX - 4
				);
			}
			ctx.fillStyle = 'rgba(85, 225, 145, 0.46)';
			const width_cells_to_draw = new Set(state.width_cells);
			if (state.symmetry) {
				for (const key of state.width_cells) {
					const [column, row] = parseCell(key);
					width_cells_to_draw.add(`${GRID - column - 1},${row}`);
				}
			}
			for (const key of width_cells_to_draw) {
				const [column, row] = parseCell(key);
				ctx.fillRect(
					column * CELL_PX + 3,
					(GRID - row - 1) * CELL_PX + 3,
					CELL_PX - 6,
					CELL_PX - 6
				);
			}
			const part_cube_cells_to_draw = new Set(state.part_cube_cells);
			const part_triangle_cells_to_draw = new Set(state.part_triangle_cells);
			if (state.symmetry) {
				for (const key of state.part_cube_cells) {
					const [column, row] = parseCell(key);
					part_cube_cells_to_draw.add(`${GRID - column - 1},${row}`);
				}
				for (const key of state.part_triangle_cells) {
					const [column, row] = parseCell(key);
					part_triangle_cells_to_draw.add(`${GRID - column - 1},${row}`);
				}
			}
			ctx.fillStyle = 'rgba(255, 105, 92, 0.5)';
			for (const key of part_cube_cells_to_draw) {
				const [column, row] = parseCell(key);
				ctx.fillRect(
					column * CELL_PX + 4,
					(GRID - row - 1) * CELL_PX + 4,
					CELL_PX - 8,
					CELL_PX - 8
				);
			}
			ctx.fillStyle = 'rgba(125, 125, 255, 0.55)';
			for (const key of part_triangle_cells_to_draw) {
				const [column, row] = parseCell(key);
				ctx.fillRect(
					column * CELL_PX + 4,
					(GRID - row - 1) * CELL_PX + 4,
					CELL_PX - 8,
					CELL_PX - 8
				);
			}

			for (let i = 0; i <= GRID; i++) {
				ctx.beginPath();
				ctx.moveTo(i * CELL_PX + 0.5, 0);
				ctx.lineTo(i * CELL_PX + 0.5, CANVAS_SIZE);
				ctx.moveTo(0, i * CELL_PX + 0.5);
				ctx.lineTo(CANVAS_SIZE, i * CELL_PX + 0.5);
				ctx.strokeStyle = i % 4 === 0 ? 'rgba(171, 197, 221, 0.28)' : 'rgba(171, 197, 221, 0.11)';
				ctx.lineWidth = i % 4 === 0 ? 1 : 0.6;
				ctx.stroke();
			}

			ctx.beginPath();
			ctx.moveTo(CANVAS_SIZE / 2, 0);
			ctx.lineTo(CANVAS_SIZE / 2, CANVAS_SIZE);
			ctx.moveTo(0, CANVAS_SIZE / 2);
			ctx.lineTo(CANVAS_SIZE, CANVAS_SIZE / 2);
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
			ctx.lineWidth = 1;
			ctx.stroke();

			if (state.closed && polygons && polygons.length) {
				for (const polygon of polygons) {
					ctx.beginPath();
					polygon.forEach((point, index) => {
						const x = point.x * CELL_PX;
						const y = CANVAS_SIZE - point.y * CELL_PX;
						if (index === 0) ctx.moveTo(x, y);
						else ctx.lineTo(x, y);
					});
					ctx.closePath();
					ctx.strokeStyle = '#ffca62';
					ctx.lineWidth = 2.5;
					ctx.stroke();
				}
				if (state.smooth > 0 && path.length) {
					ctx.beginPath();
					path.forEach((point, index) => {
						const x = point.x * CELL_PX;
						const y = CANVAS_SIZE - point.y * CELL_PX;
						if (index === 0) ctx.moveTo(x, y);
						else ctx.lineTo(x, y);
					});
					ctx.strokeStyle = 'rgba(117, 214, 255, 0.4)';
					ctx.lineWidth = 1;
					ctx.stroke();
				}
			} else if (path && path.length) {
				ctx.beginPath();
				path.forEach((point, index) => {
					const x = point.x * CELL_PX;
					const y = CANVAS_SIZE - point.y * CELL_PX;
					if (index === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				});
				ctx.strokeStyle = '#ffca62';
				ctx.lineWidth = 2.5;
				ctx.stroke();
				if (state.symmetry) {
					ctx.beginPath();
					path.forEach((point, index) => {
						const x = (GRID - point.x) * CELL_PX;
						const y = CANVAS_SIZE - point.y * CELL_PX;
						if (index === 0) ctx.moveTo(x, y);
						else ctx.lineTo(x, y);
					});
					ctx.strokeStyle = 'rgba(117, 214, 255, 0.72)';
					ctx.lineWidth = 1.5;
					ctx.stroke();
				}
			}

			if (state.points.length) {
				const start = state.points[0];
				const end = state.points[state.points.length - 1];
				ctx.beginPath();
				ctx.arc(start.x * CELL_PX, CANVAS_SIZE - start.y * CELL_PX, 4.5, 0, Math.PI * 2);
				ctx.fillStyle = '#ffca62';
				ctx.fill();
				ctx.strokeStyle = '#1a2028';
				ctx.lineWidth = 1.5;
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(end.x * CELL_PX, CANVAS_SIZE - end.y * CELL_PX, 3, 0, Math.PI * 2);
				ctx.fillStyle = '#75d6ff';
				ctx.fill();
			}

			if (!state.points.length) {
				ctx.fillStyle = 'rgba(230, 240, 255, 0.66)';
				ctx.font = '600 16px sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText('按住鼠标拖动，开始画线', CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 8);
				ctx.font = '13px sans-serif';
				ctx.fillStyle = 'rgba(230, 240, 255, 0.44)';
				ctx.fillText('松开不会闭合；可接着画或手动闭合', CANVAS_SIZE / 2, CANVAS_SIZE / 2 + 18);
			}
		}

		function updateStats(polygons) {
			if (!stats_node) return;
			const polygon = polygons && polygons[0] ? polygons[0] : [];
			if (!state.closed) {
				stats_node.textContent = state.mode === 'triangle_face' && polygon.length
					? `已选择 ${Math.min(polygon.length, 3)} / 3 个三角面角点`
					: polygon.length
						? `已经画了 ${polygon.length} 个路径点，轮廓尚未闭合`
					: '还没有开始画线';
				stats_node.dataset.ready = 'false';
				return;
			}
			const valid_polygons = polygons.filter(points => points && points.length >= 3);
			const cells = state.preview_cells.size;
			if (!valid_polygons.length || !cells) {
				stats_node.textContent = '轮廓已经闭合，但没有形成有效面积';
				stats_node.dataset.ready = 'false';
				return;
			}

			if (state.mode === 'triangle_face') {
				stats_node.textContent = state.depth > 1e-5
					? `${valid_polygons.length} 个纯三角形，Z 尺寸 ${trimFloatNumber(state.depth)}`
					: `${valid_polygons.length} 个纯三角面（Z=0）`;
			} else if (state.mode === 'cube') {
				const bend_active = Math.abs(state.bend_amount) >= 1e-6 && state.bend_columns.size > 0;
				const count = bend_active
					? mergeCellsByColumn(state.preview_cells).length
					: state.merge ? mergeCells(state.preview_cells).length : cells;
				stats_node.textContent = `占用 ${cells} 格 → ${count} 个方块组件`;
			} else if (state.mode === 'custom') {
				const parts = getCustomPartCells();
				const cube_count = state.merge
					? mergeCells(parts.cube_cells).length
					: parts.cube_cells.size;
				stats_node.textContent = `${cube_count} 个方块部位 + ${parts.triangle_cells.size} 个三角部位`;
			} else if (state.mode === 'hybrid') {
				const bend_active = Math.abs(state.bend_amount) >= 1e-6 && state.bend_columns.size > 0;
				const cube_count = state.include_cubes
					? bend_active
						? mergeCellsByColumn(state.hybrid_core).length
						: state.merge
							? mergeCells(state.hybrid_core).length
							: state.hybrid_core.size
					: 0;
				stats_node.textContent = `${cube_count} 个内部方块 + 连续三角填充外壳`;
			} else {
				let point_count = 0;
				for (const shape of valid_polygons) {
					point_count += shape.length;
				}
				stats_node.textContent = `轮廓 ${point_count} 点 → 连续三角填充 / 1 个网格`;
			}
			if (state.bend_columns.size) {
				const effective_bend_columns = new Set(state.bend_columns);
				if (state.symmetry) {
					for (const column of state.bend_columns) {
						effective_bend_columns.add(GRID - column - 1);
					}
				}
				stats_node.textContent += `；弯曲 ${effective_bend_columns.size} 列 / 过渡 ${state.bend_falloff} 格 / ${state.bend_return ? '平滑回正' : '保持弯曲'}`;
			}
			if (state.width_columns.size && Math.abs(state.width_factor - 1) > 1e-6) {
				const effective_width_columns = new Set(state.width_columns);
				if (state.symmetry) {
					for (const column of state.width_columns) {
						effective_width_columns.add(GRID - column - 1);
					}
				}
				stats_node.textContent += `；宽度 ${effective_width_columns.size} 列 × ${trimFloatNumber(state.width_factor)} / 过渡 ${state.width_falloff} 格`;
			}
			stats_node.dataset.ready = 'true';
		}

		function pointerToGrid(event) {
			const rect = canvas.getBoundingClientRect();
			let x = (event.clientX - rect.left) / rect.width * GRID;
			let y = GRID - (event.clientY - rect.top) / rect.height * GRID;
			if (state.snap) {
				const increment = event.shiftKey ? 1 : 0.25;
				x = Math.round(x / increment) * increment;
				y = Math.round(y / increment) * increment;
			}
			return {
				x: clamp(x, 0, GRID),
				y: clamp(y, 0, GRID)
			};
		}

		function addPoint(point) {
			const previous = state.points[state.points.length - 1];
			if (!previous || distance(previous, point) >= 0.12) {
				state.points.push(point);
			}
		}

		function rebuildBendColumns() {
			state.bend_columns = new Set();
			for (const key of state.bend_cells) {
				state.bend_columns.add(parseCell(key)[0]);
			}
		}

		function paintBendCell(event, erase = false) {
			const point = pointerToGrid(event);
			const column = clamp(Math.floor(point.x), 0, GRID - 1);
			const row = clamp(Math.floor(point.y), 0, GRID - 1);
			const keys = [`${column},${row}`];
			if (state.symmetry) {
				keys.push(`${GRID - column - 1},${row}`);
			}
			for (const key of keys) {
				if (erase) state.bend_cells.delete(key);
				else state.bend_cells.add(key);
			}
			rebuildBendColumns();
			updatePreview();
		}

		function setBendSelecting(enabled) {
			if (enabled) {
				state.part_selecting = false;
				const part_button = dialog.object.querySelector('#dst_part_button');
				if (part_button) {
					part_button.classList.remove('active');
					part_button.textContent = '部位选择';
				}
				state.width_selecting = false;
				const width_button = dialog.object.querySelector('#dst_width_button');
				if (width_button) {
					width_button.classList.remove('active');
					width_button.textContent = '宽度选择';
				}
			}
			state.bend_selecting = enabled;
			state.drawing = false;
			active_pointer = null;
			const bend_button = dialog.object.querySelector('#dst_bend_button');
			if (bend_button) {
				bend_button.classList.toggle('active', enabled);
				bend_button.textContent = enabled ? '退出弯曲选择' : '弯曲选择';
			}
			if (hint_node) {
				hint_node.textContent = enabled
					? '弯曲选择：在网格上涂抹需要弯曲的列；按住 Alt 可擦除。'
					: '已退出弯曲选择，可以继续画轮廓或生成形状。';
			}
			updatePreview();
		}

		function clearBendSelection() {
			state.bend_cells = new Set();
			state.bend_columns = new Set();
			updatePreview();
		}

		function rebuildWidthColumns() {
			state.width_columns = new Set();
			for (const key of state.width_cells) {
				state.width_columns.add(parseCell(key)[0]);
			}
		}

		function paintWidthCell(event, erase = false) {
			const point = pointerToGrid(event);
			const column = clamp(Math.floor(point.x), 0, GRID - 1);
			const row = clamp(Math.floor(point.y), 0, GRID - 1);
			const keys = [`${column},${row}`];
			if (state.symmetry) keys.push(`${GRID - column - 1},${row}`);
			for (const key of keys) {
				if (erase) state.width_cells.delete(key);
				else state.width_cells.add(key);
			}
			rebuildWidthColumns();
			updatePreview();
		}

		function setWidthSelecting(enabled) {
			if (enabled) {
				state.part_selecting = false;
				const part_button = dialog.object.querySelector('#dst_part_button');
				if (part_button) {
					part_button.classList.remove('active');
					part_button.textContent = '部位选择';
				}
				state.bend_selecting = false;
				const bend_button = dialog.object.querySelector('#dst_bend_button');
				if (bend_button) {
					bend_button.classList.remove('active');
					bend_button.textContent = '弯曲选择';
				}
			}
			state.width_selecting = enabled;
			state.drawing = false;
			active_pointer = null;
			const width_button = dialog.object.querySelector('#dst_width_button');
			if (width_button) {
				width_button.classList.toggle('active', enabled);
				width_button.textContent = enabled ? '退出宽度选择' : '宽度选择';
			}
			if (hint_node) {
				hint_node.textContent = enabled
					? '宽度选择：在网格上涂抹需要加宽或收窄的列；按住 Alt 可擦除。'
					: '已退出宽度选择，可以继续画轮廓或生成形状。';
			}
			updatePreview();
		}

		function clearWidthSelection() {
			state.width_cells = new Set();
			state.width_columns = new Set();
			updatePreview();
		}

		function paintPartCell(event, erase = false) {
			const point = pointerToGrid(event);
			const column = clamp(Math.floor(point.x), 0, GRID - 1);
			const row = clamp(Math.floor(point.y), 0, GRID - 1);
			const keys = [`${column},${row}`];
			if (state.symmetry) keys.push(`${GRID - column - 1},${row}`);
			for (const key of keys) {
				if (erase) {
					state.part_cube_cells.delete(key);
					state.part_triangle_cells.delete(key);
				} else if (state.part_brush === 'triangle') {
					state.part_cube_cells.delete(key);
					state.part_triangle_cells.add(key);
				} else {
					state.part_triangle_cells.delete(key);
					state.part_cube_cells.add(key);
				}
			}
			updatePreview();
		}

		function setPartSelecting(enabled) {
			if (enabled) {
				state.bend_selecting = false;
				state.width_selecting = false;
				const bend_button = dialog.object.querySelector('#dst_bend_button');
				if (bend_button) {
					bend_button.classList.remove('active');
					bend_button.textContent = '弯曲选择';
				}
				const width_button = dialog.object.querySelector('#dst_width_button');
				if (width_button) {
					width_button.classList.remove('active');
					width_button.textContent = '宽度选择';
				}
			}
			state.part_selecting = enabled;
			state.drawing = false;
			active_pointer = null;
			const part_button = dialog.object.querySelector('#dst_part_button');
			if (part_button) {
				part_button.classList.toggle('active', enabled);
				part_button.textContent = enabled ? '退出部位选择' : '部位选择';
			}
			if (hint_node) {
				hint_node.textContent = enabled
					? `部位选择：当前标记为${state.part_brush === 'triangle' ? '三角形' : '方块'}；按住 Alt 可擦除。`
					: '已退出部位选择，可以继续画轮廓或生成形状。';
			}
			updatePreview();
		}

		function clearPartSelection() {
			state.part_cube_cells = new Set();
			state.part_triangle_cells = new Set();
			updatePreview();
		}

		function clearPath() {
			state.points = [];
			state.preview_cells = new Set();
			state.drawing = false;
			state.closed = false;
			state.trimmed = false;
			active_pointer = null;
			if (hint_node) hint_node.textContent = '按住拖动画线；松开只结束这一笔，不会自动闭合。';
			updatePreview();
		}

		function closeCurrentPath() {
			state.drawing = false;
			active_pointer = null;
			let points = removeNearDuplicates(state.points);
			if (points.length < 3) {
				if (hint_node) hint_node.textContent = '至少需要画出一条有转折的线，才能手动闭合。';
				updatePreview();
				return false;
			}
			if (distance(points[0], points[points.length - 1]) < 0.75) {
				points.pop();
			}
			const polygon = cleanPolygon(points);
			if (!polygon.length) {
				state.closed = false;
				if (hint_node) hint_node.textContent = '轮廓无法有效闭合，请清空后重新画线。';
				updatePreview();
				return false;
			}
			state.points = polygon;
			state.closed = true;
			if (hint_node) {
				hint_node.textContent = state.trimmed
					? '轮廓已闭合，但检测到交叉并自动修剪了一部分。'
					: '轮廓已手动闭合，可以调整参数后点击“生成形状”。';
			}
			updatePreview();
			return true;
		}

		function readNumber(id, fallback, min, max) {
			const input = dialog.object.querySelector(`#${id}`);
			const value = parseFloat(input.value);
			const result = Number.isFinite(value) ? clamp(value, min, max) : fallback;
			input.value = String(result);
			return result;
		}

		function syncStateFromInputs() {
			const mode_input = dialog.object.querySelector('#dst_mode');
			const plane_input = dialog.object.querySelector('#dst_plane');
			state.mode = mode_input.value;
			state.plane = plane_input.value;
			state.cell_size = readNumber('dst_cell_size', 1, 0.0625, 8);
			state.depth = readNumber(
				'dst_depth',
				2,
				state.mode === 'triangle_face' ? 0 : 0.0625,
				64
			);
			state.smooth = parseInt(dialog.object.querySelector('#dst_smooth').value) || 0;
			state.bend_amount = readNumber('dst_bend', 0, -16, 16);
			state.bend_falloff = readNumber('dst_bend_falloff', 4, 1, 10);
			state.bend_return = dialog.object.querySelector('#dst_bend_return').checked;
			state.width_factor = readNumber('dst_width_factor', 1, 0.25, 4);
			state.width_falloff = readNumber('dst_width_falloff', 4, 1, 10);
			state.custom_default = dialog.object.querySelector('#dst_custom_default').value;
			state.part_brush = dialog.object.querySelector('#dst_part_brush').value;
			state.include_cubes = dialog.object.querySelector('#dst_include_cubes').checked;
			state.symmetry = dialog.object.querySelector('#dst_symmetry').checked;
			state.merge = dialog.object.querySelector('#dst_merge').checked;
			state.snap = dialog.object.querySelector('#dst_snap').checked;
			if (dialog.object.querySelector('#dst_point_width')) {
				state.point_width = readNumber('dst_point_width', 0.5, 0.0625, 8);
			}
			state.origin = [
				readNumber('dst_origin_x', state.origin[0], -4096, 4096),
				readNumber('dst_origin_y', state.origin[1], -4096, 4096),
				readNumber('dst_origin_z', state.origin[2], -4096, 4096)
			];
		}

		function refreshFormatState() {
			if (!dialog || !dialog.object) return;
			const triangle_face_option = dialog.object.querySelector('#dst_mode option[value="triangle_face"]');
			const triangle_option = dialog.object.querySelector('#dst_mode option[value="triangles"]');
			const hybrid_option = dialog.object.querySelector('#dst_mode option[value="hybrid"]');
			const custom_option = dialog.object.querySelector('#dst_mode option[value="custom"]');
			const mesh_supported = !!(Format && Format.meshes);
			triangle_face_option.disabled = !mesh_supported;
			triangle_option.disabled = !mesh_supported;
			hybrid_option.disabled = !mesh_supported;
			custom_option.disabled = !mesh_supported;
			const smooth_control = dialog.object.querySelector('#dst_smooth');
			if (smooth_control) smooth_control.disabled = state.mode === 'triangle_face';
			const depth_control = dialog.object.querySelector('#dst_depth');
			if (depth_control) {
				depth_control.disabled = false;
				depth_control.min = state.mode === 'triangle_face' ? '0' : '0.0625';
			}
			const include_cubes_control = dialog.object.querySelector('#dst_include_cubes');
			if (include_cubes_control) include_cubes_control.disabled = state.mode !== 'hybrid';
			const merge_control = dialog.object.querySelector('#dst_merge');
			if (merge_control) {
				merge_control.disabled = state.mode === 'hybrid' && !state.include_cubes;
			}
			const note = dialog.object.querySelector('#dst_format_note');
			if (mesh_supported) {
				note.textContent = `当前格式 ${Format.name || Format.id} 支持网格，可使用三角形或混合模式。`;
				note.dataset.warning = 'false';
			} else {
				note.textContent = `当前格式 ${Format ? (Format.name || Format.id) : '未载入'} 不导出任意网格；请使用方块模式，或新建 Generic Model / Free Model 后使用三角形/混合模式。`;
				note.dataset.warning = 'true';
				if (
					state.mode === 'triangle_face' ||
					state.mode === 'triangles' ||
					state.mode === 'hybrid' ||
					state.mode === 'custom'
				) {
					state.mode = 'cube';
					dialog.object.querySelector('#dst_mode').value = 'cube';
				}
			}
		}

		function generateShape() {
			if (!Project || !Format) {
				Blockbench.showMessageBox({
					title: '手绘形状生成器',
					message: '请先打开或新建一个模型项目。',
					icon: 'info'
				});
				return false;
			}
			syncStateFromInputs();
			refreshFormatState();
			const polygons = state.closed ? getShapePolygons(state.points) : [];

			if (!polygons.length || !state.preview_cells.size) {
				Blockbench.showMessageBox({
					title: '还没有闭合形状',
					message: '请先继续画到起点完成闭合，或点击“闭合轮廓”按钮。',
					icon: 'info'
				});
				return false;
			}
			if (
				(
					state.mode === 'triangle_face' ||
					state.mode === 'triangles' ||
					state.mode === 'hybrid' ||
					state.mode === 'custom'
				) &&
				!Format.meshes
			) {
				Blockbench.showMessageBox({
					title: '当前格式不支持三角形网格',
					message: 'Java Block/Item 等格式不能导出任意网格。请使用纯方块模式，或新建 Generic Model / Free Model 后再生成三角形或混合模型。',
					icon: 'info'
				});
				return false;
			}
			if (
				state.mode === 'triangles' &&
				!polygons.every(polygon => triangulatePolygon(polygon).length)
			) {
				Blockbench.showMessageBox({
					title: '轮廓太复杂',
					message: '这个轮廓无法稳定三角化。请清除后画得更简单，并避免笔画交叉。',
					icon: 'warning'
				});
				return false;
			}
			if (state.mode === 'triangle_face' &&
				!polygons.every(polygon => polygon.length === 3 && Math.abs(signedArea(polygon)) >= 1e-5)) {
				Blockbench.showMessageBox({
					title: '不能生成纯三角面',
					message: '请依次点击三个不共线的角点。',
					icon: 'warning'
				});
				return false;
			}

			const created_elements = [];
			const created_groups = [];
			Undo.initEdit({elements: [], groups: [], outliner: true, selection: true});

			try {
				const group_prefix = state.mode === 'cube'
					? 'drawn_cube_shape'
					: state.mode === 'hybrid'
						? 'drawn_hybrid_shape'
						: state.mode === 'custom'
							? 'custom_mix_shape'
						: state.mode === 'triangle_face'
							? 'pure_triangle_shape'
							: 'drawn_triangle_shape';
				const group = createGroup(makeShapeName(group_prefix));
				created_groups.push(group);

				if (state.mode === 'cube') {
					created_elements.push(...createCubeShape(group, state.preview_cells));
				} else if (state.mode === 'hybrid') {
					const hybrid = createHybridShape(group, polygons);
					created_elements.push(...hybrid.cubes);
					if (hybrid.mesh) created_elements.push(hybrid.mesh);
				} else if (state.mode === 'custom') {
					const custom = createCustomMixShape(group, polygons);
					created_elements.push(...custom.cubes);
					if (custom.mesh) created_elements.push(custom.mesh);
				} else if (state.mode === 'triangle_face') {
					created_elements.push(createPureTriangle(group, polygons));
				} else {
					created_elements.push(createTriangleShape(group, polygons));
				}

				if (!created_elements.length) {
					throw new Error('没有生成任何元素，请重新画一个更大的形状。');
				}
				const group_origin = rebaseGeneratedGroup(group, created_elements);

				try {
					unselectAllElements();
					group.select();
					const mesh_element = created_elements.find(element => element instanceof Mesh);
					if (mesh_element) {
						UVEditor.setAutoSize(null, true, Object.keys(mesh_element.faces));
					}
					if (Texture.all.length) UVEditor.loadData();
				} catch (selection_error) {
					console.warn('Drawn Shape Tool: selection/UV refresh failed', selection_error);
				}

				Undo.finishEdit('生成手绘形状', {
					elements: created_elements,
					groups: created_groups,
					outliner: true,
					selection: true
				});

				try {
					Canvas.updateAll();
				} catch (canvas_error) {
					Canvas.updateView({
						elements: created_elements,
						element_aspects: {geometry: true, transform: true, uv: true}
					});
				}

				Blockbench.dispatchEvent('add_drawn_shape', {
					elements: created_elements,
					group: group,
					mode: state.mode,
					plane: state.plane,
					position: group_origin
				});
				Blockbench.showQuickMessage(
					state.mode === 'cube'
						? '已生成方块形状，并选中整组'
						: state.mode === 'hybrid'
							? '已生成混合模型，并选中整组'
							: state.mode === 'custom'
								? '已生成按位置混合模型，并选中整组'
							: state.mode === 'triangle_face'
								? '已生成纯三角面，并选中整组'
								: '已生成三角形网格，并选中整组'
				);
				return true;
			} catch (error) {
				console.error('Drawn Shape Tool:', error);
				try {
					Undo.cancelEdit();
				} catch (cancel_error) {
					console.warn('Drawn Shape Tool: Undo cancel failed', cancel_error);
				}
				Blockbench.showMessageBox({
					title: '生成失败',
					message: error && error.message ? error.message : String(error),
					icon: 'error'
				});
				return false;
			}
		}

		function buildInterface(host) {
			const wrapper = createElement('div', 'dst_wrapper');

			const draw_panel = createElement('section', 'dst_draw_panel');
			const toolbar = createElement('div', 'dst_toolbar');
			toolbar.innerHTML = `
				<label class="dst_field">
					<span>生成方式</span>
					<select id="dst_mode">
						<option value="cube">小方块</option>
						<option value="triangle_face">纯三角形（3 点）</option>
						<option value="triangles">厚三角网格</option>
						<option value="hybrid">方块 + 三角形（混合）</option>
						<option value="custom">按位置混合（方块/三角）</option>
					</select>
				</label>
				<label class="dst_field">
					<span>绘制平面</span>
					<select id="dst_plane">
						<option value="xy">XY / 正视</option>
						<option value="xz">XZ / 顶视</option>
						<option value="yz">YZ / 侧视</option>
					</select>
				</label>
				<label class="dst_field">
					<span>格子大小</span>
					<input id="dst_cell_size" type="number" min="0.0625" max="8" step="0.25" value="1">
				</label>
				<label class="dst_field">
					<span>Z 尺寸 / 厚度</span>
					<input id="dst_depth" type="number" min="0" max="64" step="0.25" value="2">
				</label>
			`;

			const canvas_shell = createElement('div', 'dst_canvas_shell');
			canvas = document.createElement('canvas');
			canvas.id = 'dst_canvas';
			canvas.width = CANVAS_SIZE;
			canvas.height = CANVAS_SIZE;
			canvas.setAttribute('aria-label', '手绘形状网格');
			canvas_shell.append(canvas);
			canvas_context = canvas.getContext('2d');

			const canvas_footer = createElement('div', 'dst_canvas_footer');
			const close_button = createElement('button', 'dst_secondary_button', '闭合轮廓');
			close_button.type = 'button';
			const clear_button = createElement('button', 'dst_secondary_button', '清空画布');
			clear_button.type = 'button';
			const bend_button = createElement('button', 'dst_secondary_button', '弯曲选择');
			bend_button.id = 'dst_bend_button';
			bend_button.type = 'button';
			const clear_bend_button = createElement('button', 'dst_secondary_button', '清除弯曲');
			clear_bend_button.type = 'button';
			const width_button = createElement('button', 'dst_secondary_button', '宽度选择');
			width_button.id = 'dst_width_button';
			width_button.type = 'button';
			const clear_width_button = createElement('button', 'dst_secondary_button', '清除宽度');
			clear_width_button.type = 'button';
			const part_button = createElement('button', 'dst_secondary_button', '部位选择');
			part_button.id = 'dst_part_button';
			part_button.type = 'button';
			const clear_part_button = createElement('button', 'dst_secondary_button', '清除部位');
			clear_part_button.type = 'button';
			const snap_label = createElement('label', 'dst_check');
			const snap_check = document.createElement('input');
			snap_check.id = 'dst_snap';
			snap_check.type = 'checkbox';
			snap_check.checked = true;
			snap_label.append(snap_check, document.createTextNode('吸附网格（Shift：整格）'));
			canvas_footer.append(
				close_button,
				clear_button,
				bend_button,
				clear_bend_button,
				width_button,
				clear_width_button,
				part_button,
				clear_part_button,
				snap_label
			);

			const hint = createElement('div', 'dst_hint');
			hint_node = createElement('div', 'dst_hint_main', '按住拖动画线；松开只结束这一笔，不会自动闭合。');
			const format_note = createElement('div', 'dst_format_note');
			format_note.id = 'dst_format_note';
			hint.append(hint_node, format_note);

			const point_panel = createElement('section', 'dst_point_panel');
			const point_title = createElement('h4', '', '视口取点：2 点连线 / 3 点成面 / 4 点成方块');
			const point_row = createElement('div', 'dst_canvas_footer');
			const point_toggle = createElement('button', 'dst_secondary_button', '在视口取点');
			point_toggle.id = 'dst_point_toggle';
			point_toggle.type = 'button';
			const point_make = createElement('button', 'dst_secondary_button', '生成当前形状');
			point_make.type = 'button';
			const point_undo = createElement('button', 'dst_secondary_button', '撤销上一点');
			point_undo.type = 'button';
			const point_clear = createElement('button', 'dst_secondary_button', '清空点');
			point_clear.type = 'button';
			const point_width_field = createElement('label', 'dst_field');
			const point_width_title = createElement('span', '', '线宽 / 最小厚度');
			const point_width_input = document.createElement('input');
			point_width_input.id = 'dst_point_width';
			point_width_input.type = 'number';
			point_width_input.min = '0.0625';
			point_width_input.max = '8';
			point_width_input.step = '0.0625';
			point_width_input.value = '0.5';
			point_width_field.append(point_width_title, point_width_input);
			point_row.append(point_toggle, point_make, point_undo, point_clear, point_width_field);
			const point_info = createElement(
				'div',
				'dst_hint_main',
				'点击“在视口取点”，然后把本对话框拖到一边，在 3D 视口里点击放点'
			);
			point_info.id = 'dst_point_info';
			point_panel.append(point_title, point_row, point_info);

			draw_panel.append(toolbar, canvas_shell, canvas_footer, hint, point_panel);

			point_toggle.addEventListener('click', () => {
				if (state.point_mode) stopPointMode(false);
				else startPointMode();
			});
			point_make.addEventListener('click', () => createPointShape(false));
			point_undo.addEventListener('click', () => {
				if (state.point_points.length) state.point_points.pop();
				updatePointPanel();
			});
			point_clear.addEventListener('click', () => {
				state.point_points = [];
				updatePointPanel();
			});

			const settings_panel = createElement('aside', 'dst_settings_panel');
			const settings_title = createElement('h3', '', '生成设置');
			const settings_help = createElement(
				'p',
				'dst_help',
				'生成结果会放入独立组，组枢轴自动放在模型中心。拖动整组不会影响其他模型或组。'
			);

			const origin_title = createElement('h4', '', '生成位置（整组 X / Y / Z）');
			const origin_grid = createElement('div', 'dst_origin_grid');
			['x', 'y', 'z'].forEach(axis => {
				const label = createElement('label', 'dst_origin_field', axis.toUpperCase());
				const input = document.createElement('input');
				input.id = `dst_origin_${axis}`;
				input.type = 'number';
				input.step = '1';
				input.value = '0';
				label.append(input);
				origin_grid.append(label);
			});
			const origin_help = createElement(
				'p',
				'dst_help dst_origin_help',
				'Z 控制整组前后位置；纯三角形的 Z 尺寸由上方“Z 尺寸 / 厚度”控制。'
			);

			const merge_label = createElement('label', 'dst_option');
			const merge_check = document.createElement('input');
			merge_check.id = 'dst_merge';
			merge_check.type = 'checkbox';
			merge_check.checked = true;
			merge_label.append(merge_check, document.createTextNode('合并连续方块（推荐）'));

			const symmetry_label = createElement('label', 'dst_option');
			const symmetry_check = document.createElement('input');
			symmetry_check.id = 'dst_symmetry';
			symmetry_check.type = 'checkbox';
			symmetry_label.append(symmetry_check, document.createTextNode('左右对称（只画一半）'));

			const include_cubes_label = createElement('label', 'dst_option');
			const include_cubes_check = document.createElement('input');
			include_cubes_check.id = 'dst_include_cubes';
			include_cubes_check.type = 'checkbox';
			include_cubes_label.append(
				include_cubes_check,
				document.createTextNode('混合模式保留内部方块（默认关闭）')
			);

			const custom_default_field = createElement('label', 'dst_field dst_smooth_field');
			const custom_default_title = createElement('span', '', '按位置混合：默认部位');
			const custom_default_select = document.createElement('select');
			custom_default_select.id = 'dst_custom_default';
			[
				['cube', '默认方块'],
				['triangle', '默认三角形']
			].forEach(([value, label]) => {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				custom_default_select.append(option);
			});
			custom_default_field.append(custom_default_title, custom_default_select);

			const part_brush_field = createElement('label', 'dst_field dst_smooth_field');
			const part_brush_title = createElement('span', '', '部位选择：标记为');
			const part_brush_select = document.createElement('select');
			part_brush_select.id = 'dst_part_brush';
			[
				['cube', '方块'],
				['triangle', '三角形']
			].forEach(([value, label]) => {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				part_brush_select.append(option);
			});
			part_brush_select.value = 'cube';
			part_brush_field.append(part_brush_title, part_brush_select);

			const smooth_field = createElement('label', 'dst_field dst_smooth_field');
			const smooth_title = createElement('span', '', '圆润程度');
			const smooth_select = document.createElement('select');
			smooth_select.id = 'dst_smooth';
			[
				['0', '关闭 / 保留锐角'],
				['1', '轻度圆润（推荐）'],
				['2', '中等圆润'],
				['3', '高度圆润']
			].forEach(([value, label]) => {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				smooth_select.append(option);
			});
			smooth_select.value = '1';
			smooth_field.append(smooth_title, smooth_select);

			const bend_field = createElement('label', 'dst_field dst_bend_field');
			const bend_title = createElement('span', '', '弯曲幅度（沿 Z）');
			const bend_input = document.createElement('input');
			bend_input.id = 'dst_bend';
			bend_input.type = 'number';
			bend_input.min = '-16';
			bend_input.max = '16';
			bend_input.step = '0.25';
			bend_input.value = '0';
			bend_field.append(bend_title, bend_input);

			const bend_falloff_field = createElement('label', 'dst_field dst_bend_field');
			const bend_falloff_title = createElement('span', '', '弯曲过渡宽度（格）');
			const bend_falloff_input = document.createElement('input');
			bend_falloff_input.id = 'dst_bend_falloff';
			bend_falloff_input.type = 'number';
			bend_falloff_input.min = '1';
			bend_falloff_input.max = '10';
			bend_falloff_input.step = '1';
			bend_falloff_input.value = '4';
			bend_falloff_field.append(bend_falloff_title, bend_falloff_input);

			const bend_return_label = createElement('label', 'dst_option dst_bend_return');
			const bend_return_check = document.createElement('input');
			bend_return_check.id = 'dst_bend_return';
			bend_return_check.type = 'checkbox';
			bend_return_check.checked = true;
			bend_return_label.append(
				bend_return_check,
				document.createTextNode('弯曲后平滑回正（关闭为单向斜坡）')
			);

			const width_factor_field = createElement('label', 'dst_field dst_bend_field');
			const width_factor_title = createElement('span', '', '局部宽度倍数');
			const width_factor_input = document.createElement('input');
			width_factor_input.id = 'dst_width_factor';
			width_factor_input.type = 'number';
			width_factor_input.min = '0.25';
			width_factor_input.max = '4';
			width_factor_input.step = '0.05';
			width_factor_input.value = '1';
			width_factor_field.append(width_factor_title, width_factor_input);

			const width_falloff_field = createElement('label', 'dst_field dst_bend_field');
			const width_falloff_title = createElement('span', '', '宽度过渡宽度（格）');
			const width_falloff_input = document.createElement('input');
			width_falloff_input.id = 'dst_width_falloff';
			width_falloff_input.type = 'number';
			width_falloff_input.min = '1';
			width_falloff_input.max = '10';
			width_falloff_input.step = '1';
			width_falloff_input.value = '4';
			width_falloff_field.append(width_falloff_title, width_falloff_input);

			const options_help = createElement(
				'p',
				'dst_help dst_help_compact',
				'混合模式最适合自由手绘：内部完整格合并成方块，外部使用一整块连续三角外壳，因此不会被强行概括成方块轮廓。'
			);

			stats_node = createElement('div', 'dst_stats', '还没有开始画线');
			stats_node.dataset.ready = 'false';

			settings_panel.append(
				settings_title,
				settings_help,
				origin_title,
				origin_grid,
				origin_help,
				merge_label,
				symmetry_label,
				include_cubes_label,
				custom_default_field,
				part_brush_field,
				smooth_field,
				bend_field,
				bend_falloff_field,
				bend_return_label,
				width_factor_field,
				width_falloff_field,
				options_help,
				stats_node
			);

			wrapper.append(draw_panel, settings_panel);
			host.append(wrapper);
			updatePointPanel();

			canvas.addEventListener('pointerdown', event => {
				if (event.button !== 0) return;
				event.preventDefault();
				active_pointer = event.pointerId;
				try {
					canvas.setPointerCapture(event.pointerId);
				} catch (error) {
					// Synthetic pointer events do not always have an active pointer to capture.
				}
				if (state.bend_selecting) {
					paintBendCell(event, event.altKey);
					return;
				}
				if (state.width_selecting) {
					paintWidthCell(event, event.altKey);
					return;
				}
				if (state.part_selecting) {
					paintPartCell(event, event.altKey);
					return;
				}
				if (state.closed) {
					state.points = [];
					state.preview_cells = new Set();
					state.closed = false;
				}
				state.drawing = true;
				state.trimmed = false;
				addPoint(pointerToGrid(event));
				hint_node.textContent = state.mode === 'triangle_face'
					? `已选择 ${Math.min(state.points.length, 3)} / 3 个角点，继续点击角点。`
					: '松开只会结束当前一笔；下一笔会从当前端点继续。';
				updatePreview();
			});

			canvas.addEventListener('pointermove', event => {
				if (state.bend_selecting && event.pointerId === active_pointer) {
					event.preventDefault();
					paintBendCell(event, event.altKey);
					return;
				}
				if (state.width_selecting && event.pointerId === active_pointer) {
					event.preventDefault();
					paintWidthCell(event, event.altKey);
					return;
				}
				if (state.part_selecting && event.pointerId === active_pointer) {
					event.preventDefault();
					paintPartCell(event, event.altKey);
					return;
				}
				if (!state.drawing || event.pointerId !== active_pointer) return;
				if (state.mode === 'triangle_face') return;
				event.preventDefault();
				addPoint(pointerToGrid(event));
				updatePreview();
			});

			function finishStroke(event) {
				if (state.bend_selecting || state.width_selecting || state.part_selecting) {
					active_pointer = null;
					return;
				}
				if (!state.drawing || (event && event.pointerId !== active_pointer)) return;
				event && event.preventDefault();
				state.drawing = false;
				active_pointer = null;
				if (state.mode === 'triangle_face') {
					state.points = removeNearDuplicates(state.points).slice(0, 3);
					if (state.points.length === 3 && Math.abs(signedArea(state.points)) >= 1e-5) {
						state.closed = true;
						hint_node.textContent = '三个角点已完成，可以点击“生成形状”创建纯三角面。';
					} else {
						state.closed = false;
						hint_node.textContent = state.points.length < 3
							? `已选择 ${state.points.length} / 3 个角点，继续点击角点。`
							: '三个角点共线，无法形成三角形，请清空后重新点击。';
					}
					updatePreview();
					return;
				}
				addPoint(pointerToGrid(event));
				const drawn_back_to_start = state.points.length >= 4 &&
					distance(state.points[0], state.points[state.points.length - 1]) < 0.75;
				state.points = removeNearDuplicates(state.points);
				if (drawn_back_to_start) {
					closeCurrentPath();
				} else {
					state.closed = false;
					hint_node.textContent = state.points.length
						? '这一笔已结束，轮廓仍未闭合。继续画，或点击“闭合轮廓”。'
						: '还没有画出有效线条。';
					updatePreview();
				}
			}

			canvas.addEventListener('pointerup', finishStroke);
			canvas.addEventListener('pointercancel', event => {
				if (event.pointerId !== active_pointer) return;
				state.drawing = false;
				active_pointer = null;
				updatePreview();
			});
			canvas.addEventListener('contextmenu', event => event.preventDefault());

			close_button.addEventListener('click', closeCurrentPath);
			clear_button.addEventListener('click', clearPath);
			bend_button.addEventListener('click', () => setBendSelecting(!state.bend_selecting));
			clear_bend_button.addEventListener('click', clearBendSelection);
			width_button.addEventListener('click', () => setWidthSelecting(!state.width_selecting));
			clear_width_button.addEventListener('click', clearWidthSelection);
			part_button.addEventListener('click', () => setPartSelecting(!state.part_selecting));
			clear_part_button.addEventListener('click', clearPartSelection);

			const controls = {
				dst_mode: value => {
					state.mode = value;
					if (hint_node) {
						hint_node.textContent = value === 'triangle_face'
							? '依次点击三个角点，插件会直接生成一个无厚度的纯三角面。'
							: '按住拖动画线；松开只结束这一笔，不会自动闭合。';
					}
					refreshFormatState();
					updatePreview();
				},
				dst_plane: value => {
					state.plane = value;
					updatePreview();
				},
				dst_cell_size: value => {
					state.cell_size = clamp(parseFloat(value) || 1, 0.0625, 8);
					updatePreview();
				},
				dst_depth: value => {
					const minimum = state.mode === 'triangle_face' ? 0 : 0.0625;
					state.depth = clamp(parseFloat(value) || 0, minimum, 64);
					updatePreview();
				},
				dst_smooth: value => {
					state.smooth = clamp(parseInt(value) || 0, 0, 3);
					updatePreview();
				},
				dst_bend: value => {
					state.bend_amount = clamp(parseFloat(value) || 0, -16, 16);
					updatePreview();
				},
				dst_bend_falloff: value => {
					state.bend_falloff = clamp(parseInt(value) || 4, 1, 10);
					updatePreview();
				},
				dst_width_factor: value => {
					state.width_factor = clamp(parseFloat(value) || 1, 0.25, 4);
					updatePreview();
				},
				dst_width_falloff: value => {
					state.width_falloff = clamp(parseInt(value) || 4, 1, 10);
					updatePreview();
				},
				dst_custom_default: value => {
					state.custom_default = value;
					updatePreview();
				},
				dst_part_brush: value => {
					state.part_brush = value;
					if (state.part_selecting && hint_node) {
						hint_node.textContent = `部位选择：当前标记为${value === 'triangle' ? '三角形' : '方块'}；按住 Alt 可擦除。`;
					}
				},
				dst_bend_return: (value, input) => {
					state.bend_return = input.checked;
					updatePreview();
				},
				dst_include_cubes: (value, input) => {
					state.include_cubes = input.checked;
					refreshFormatState();
					updatePreview();
				},
				dst_symmetry: (value, input) => {
					state.symmetry = input.checked;
					if (hint_node) {
						hint_node.textContent = input.checked
							? '左右对称已开启：只需在中心线一侧画一半。'
							: '按住拖动画线；松开只结束这一笔，不会自动闭合。';
					}
					updatePreview();
				},
				dst_merge: (value, input) => {
					state.merge = input.checked;
					updatePreview();
				},
				dst_snap: (value, input) => {
					state.snap = input.checked;
				},
				dst_origin_x: value => {
					state.origin[0] = parseFloat(value) || 0;
					state.origin_touched = true;
				},
				dst_origin_y: value => {
					state.origin[1] = parseFloat(value) || 0;
					state.origin_touched = true;
				},
				dst_origin_z: value => {
					state.origin[2] = parseFloat(value) || 0;
					state.origin_touched = true;
				}
			};

			Object.keys(controls).forEach(id => {
				const input = host.querySelector(`#${id}`);
				input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', event => {
					if (
						id === 'dst_mode' &&
						(
							event.target.value === 'triangle_face' ||
							event.target.value === 'triangles' ||
							event.target.value === 'hybrid' ||
							event.target.value === 'custom'
						) &&
						!Format.meshes
					) {
						event.target.value = 'cube';
						state.mode = 'cube';
						refreshFormatState();
						return;
					}
					controls[id](event.target.value, event.target);
				});
			});

			if (!state.origin_touched) {
				state.origin = defaultOrigin();
				host.querySelector('#dst_origin_x').value = String(state.origin[0]);
				host.querySelector('#dst_origin_y').value = String(state.origin[1]);
				host.querySelector('#dst_origin_z').value = String(state.origin[2]);
			}
			refreshFormatState();
			updatePreview();
		}

		style_node = Blockbench.addCSS(`
			#drawn_shape_tool_dialog .dialog_content {
				padding: 12px 14px 8px;
				max-height: min(78vh, 760px);
				overflow: auto;
			}
			.dst_wrapper {
				display: grid;
				grid-template-columns: minmax(420px, 1fr) 230px;
				gap: 16px;
				align-items: start;
				color: var(--color-text);
			}
			.dst_draw_panel,
			.dst_settings_panel {
				background: var(--color-back);
				border: 1px solid var(--color-border);
				border-radius: 8px;
			}
			.dst_draw_panel {
				padding: 12px;
			}
			.dst_settings_panel {
				padding: 14px;
			}
			.dst_toolbar {
				display: grid;
				grid-template-columns: 1.2fr 1.2fr 1fr 1fr;
				gap: 8px;
				margin-bottom: 10px;
			}
			.dst_field {
				display: flex;
				flex-direction: column;
				gap: 4px;
				font-size: 11px;
				color: var(--color-subtle_text);
			}
			.dst_field select,
			.dst_field input,
			.dst_origin_field input {
				width: 100%;
				height: 28px;
				padding: 0 6px;
				color: var(--color-text);
				background: var(--color-back);
				border: 1px solid var(--color-border);
				border-radius: 4px;
			}
			.dst_canvas_shell {
				display: flex;
				justify-content: center;
				overflow: hidden;
				background: #111821;
				border: 1px solid rgba(142, 185, 219, 0.24);
				border-radius: 6px;
			}
			#dst_canvas {
				display: block;
				width: min(100%, 432px);
				height: auto;
				aspect-ratio: 1;
				cursor: crosshair;
				touch-action: none;
			}
			.dst_canvas_footer {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 12px;
				flex-wrap: wrap;
				margin-top: 9px;
			}
			.dst_secondary_button {
				min-height: 27px;
				padding: 4px 10px;
				border-radius: 4px;
				border: 1px solid var(--color-border);
				background: var(--color-button);
				color: var(--color-text);
				cursor: pointer;
			}
			.dst_secondary_button.active {
				color: #171d24;
				background: #ffba5a;
				border-color: #ffd28a;
			}
			.dst_check,
			.dst_option {
				display: flex;
				align-items: center;
				gap: 6px;
				font-size: 11px;
				color: var(--color-subtle_text);
				cursor: pointer;
			}
			.dst_check input,
			.dst_option input {
				margin: 0;
			}
			.dst_hint {
				margin-top: 9px;
				padding: 8px 10px;
				border-radius: 5px;
				background: rgba(76, 143, 196, 0.08);
				font-size: 11px;
				line-height: 1.45;
			}
			.dst_hint_main {
				color: var(--color-text);
			}
			.dst_format_note {
				margin-top: 4px;
				color: var(--color-subtle_text);
			}
			.dst_format_note[data-warning="true"] {
				color: #e5a84f;
			}
			.dst_settings_panel h3,
			.dst_settings_panel h4 {
				margin: 0 0 7px;
			}
			.dst_settings_panel h3 {
				font-size: 14px;
			}
			.dst_settings_panel h4 {
				margin-top: 15px;
				font-size: 12px;
			}
			.dst_help {
				margin: 0 0 8px;
				font-size: 11px;
				line-height: 1.45;
				color: var(--color-subtle_text);
			}
			.dst_help_compact {
				margin-top: 12px;
			}
			.dst_origin_grid {
				display: grid;
				grid-template-columns: repeat(3, 1fr);
				gap: 5px;
			}
			.dst_origin_field {
				display: flex;
				flex-direction: column;
				gap: 3px;
				font-size: 10px;
				color: var(--color-subtle_text);
			}
			.dst_origin_help {
				margin-top: 6px;
			}
			.dst_option {
				margin-top: 4px;
			}
			.dst_smooth_field {
				margin-top: 12px;
			}
			.dst_bend_field {
				margin-top: 12px;
			}
			.dst_bend_return {
				margin-top: 9px;
			}
			.dst_stats {
				margin-top: 16px;
				padding: 9px;
				border-radius: 5px;
				background: rgba(87, 112, 134, 0.14);
				font-size: 11px;
				line-height: 1.5;
				color: var(--color-subtle_text);
			}
			.dst_stats[data-ready="true"] {
				color: #75d6ff;
			}
			.dst_point_panel {
				display: flex;
				flex-direction: column;
				gap: 6px;
				padding: 8px 10px;
				border: 1px solid rgba(87, 112, 134, 0.35);
				border-radius: 6px;
				background: rgba(87, 112, 134, 0.08);
			}
			.dst_point_panel h4 {
				margin: 0;
				font-size: 12px;
				color: var(--color-light);
			}
			.dst_point_panel .dst_canvas_footer {
				padding: 0;
				border: none;
			}
			#dst_point_toggle[data-active="true"] {
				background: rgba(255, 210, 74, 0.24);
				border-color: rgba(255, 210, 74, 0.65);
				color: #ffd24a;
			}
			.dst_point_bar {
				position: fixed;
				left: 50%;
				top: 12px;
				transform: translateX(-50%);
				display: none;
				align-items: center;
				gap: 8px;
				padding: 8px 12px;
				border-radius: 8px;
				background: rgba(18, 24, 30, 0.94);
				border: 1px solid rgba(255, 210, 74, 0.55);
				box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
				z-index: 90;
				color: #e6e6e6;
				font-size: 12px;
			}
			.dst_point_bar[data-open="true"] {
				display: flex;
			}
			.dst_point_bar button {
				padding: 4px 10px;
				border-radius: 4px;
				border: 1px solid rgba(255, 255, 255, 0.25);
				background: rgba(255, 255, 255, 0.08);
				color: inherit;
				cursor: pointer;
			}
			.dst_point_bar button:hover {
				background: rgba(255, 210, 74, 0.25);
			}
			.dst_point_bar_title {
				font-weight: 700;
				color: #ffd24a;
				white-space: nowrap;
			}
			.dst_point_bar_info {
				max-width: 520px;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				color: #b9c3cc;
			}
			@media (max-width: 760px) {
				.dst_wrapper {
					grid-template-columns: 1fr;
				}
				.dst_toolbar {
					grid-template-columns: 1fr 1fr;
				}
			}
		`, 'drawn_shape_tool');

		dialog = new Dialog({
			id: 'drawn_shape_tool_dialog',
			title: '手绘形状生成器',
			width: 790,
			resizable: 'xy',
			buttons: ['生成形状', '关闭'],
			onBuild(object) {
				const content = object.querySelector('content.dialog_content');
				buildInterface(content);
			},
			onOpen() {
				if (!Project) return;
				refreshFormatState();
				if (!state.origin_touched) {
					state.origin = defaultOrigin();
					const axes = ['x', 'y', 'z'];
					axes.forEach((axis, index) => {
						const input = this.object.querySelector(`#dst_origin_${axis}`);
						if (input) input.value = String(state.origin[index]);
					});
				}
				if (hint_node && state.mode === 'triangle_face') {
					hint_node.textContent = '依次点击三个角点，插件会直接生成一个无厚度的纯三角面。';
				}
				updatePointPanel();
				updatePreview();
			},
			onConfirm() {
				return generateShape();
			},
			onCancel() {
				state.drawing = false;
				active_pointer = null;
				stopPointMode(false);
			},
			onClose() {
				stopPointMode(false);
			}
		});

		open_action = new Action('drawn_shape_tool_open', {
			name: '手绘形状生成器',
			description: '手动画线闭合后，生成为方块、三角网格或方块与三角混合模型',
			icon: 'gesture',
			category: 'edit',
			condition: () => !!Project && !!Format,
			click() {
				dialog.show();
			}
		});
		MenuBar.addAction(open_action, 'tools');
		drawn_shape_tool_resources.dialog = dialog;
		drawn_shape_tool_resources.action = open_action;
		drawn_shape_tool_resources.style = style_node;
		drawn_shape_tool_resources.cleanup = () => {
			try {
				stopPointMode(false);
			} catch (error) {
				console.warn('Drawn Shape Tool: point mode cleanup failed', error);
			}
			if (point_overlay) {
				point_overlay.remove();
				point_overlay = null;
			}
			if (point_bar) {
				point_bar.remove();
				point_bar = null;
			}
		};

		console.log('Drawn Shape Tool loaded');
	},

	onunload() {
		try {
			if (drawn_shape_tool_resources.cleanup) drawn_shape_tool_resources.cleanup();
		} catch (error) {
			console.warn('Drawn Shape Tool unload cleanup:', error);
		}
		try {
			MenuBar.removeAction('tools.drawn_shape_tool_open');
		} catch (error) {
			console.warn(error);
		}
		try {
			if (drawn_shape_tool_resources.action) drawn_shape_tool_resources.action.delete();
			if (drawn_shape_tool_resources.dialog && drawn_shape_tool_resources.dialog.object) {
				drawn_shape_tool_resources.dialog.hide();
			}
			if (drawn_shape_tool_resources.dialog) drawn_shape_tool_resources.dialog.delete();
			if (drawn_shape_tool_resources.style) drawn_shape_tool_resources.style.delete();
		} catch (error) {
			console.warn('Drawn Shape Tool unload cleanup:', error);
		}
		drawn_shape_tool_resources.dialog = null;
		drawn_shape_tool_resources.action = null;
		drawn_shape_tool_resources.style = null;
	}
});
