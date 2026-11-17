# Blockbench Drawn Shape Tool

## Installation

1. Open Blockbench 5.2.2.
2. Go to `File → Plugins`.
3. Click `Load Plugin from File`.
4. Select `drawn_shape_tool.js`.
5. Click `手绘形状生成器` in the top `Tools` menu.

The plugin file must keep the name `drawn_shape_tool.js`.

## Usage

1. Hold and drag the mouse on the grid to draw freely. Releasing the button only ends the current stroke; it does not connect the start and end points automatically.
2. Keep drawing until the last stroke returns to the start point, or press `Close Outline` to connect the current end point to the start manually. Filling and generation only happen once the outline is closed.
3. Choose a generation mode:
   - `Small cubes`: creates editable cuboids; works in Java Block/Item, Bedrock and any project that supports cubes.
   - `Plain triangle (3 points)`: click three corners in order to generate a triangle without roundness. When `Z size / thickness` is 0 it is a single face; when greater than 0 it becomes a triangular prism with adjustable Z size.
   - `Thick triangle mesh`: generates a closed triangle mesh with adjustable thickness, for `Generic Model / Free Model`.
   - `Cubes + triangles (hybrid)`: by default only one smooth triangle shell is generated; enable `Keep inner cubes in hybrid mode` to add inner cubes as well.
4. Set cell size, thickness, drawing plane, model coordinate center and `Roundness`. Light roundness is recommended.
5. Click `Generate Shape`. The result is placed in a new `drawn_*_shape_*` group.

Hybrid mode does not generate inner cubes by default, so there are no extra cube bumps. Enable `Keep inner cubes in hybrid mode` when you need solid volume; the inner cubes are slightly inset from the shell to avoid coplanar flickering.

The front and back fills of the triangle shell are split into continuous triangles cell by cell instead of closing a complex concave polygon in one step. Bending therefore still fills the interior completely without generating extra cubes.

`Roundness` rounds both the 2D outline and the front/back edges. Turning it off keeps the original sharp corners; light suits most hand-drawn lines, and medium/high suit circular or organic shapes.

Plain triangle mode disables the roundness setting so the three corners stay sharp instead of turning into arcs.

## Z position and moving the whole group

The Z value in `Generate position (group X / Y / Z)` sets the front-to-back position of the whole generated model. A plain triangle with Z size 0 is a movable single face; set `Z size / thickness` above 0 to get a triangular prism whose Z size can be adjusted directly.

After generation the whole group is selected automatically. The group pivot is placed at the bounding-box center, so moving or transforming the new group with the move tool or transform controls only affects the new model and never modifies existing groups.

## Mirror symmetry

When `Mirror symmetry (draw half only)` is enabled, you only need to draw the right side of the center line. Endpoints near the center line snap to the axis, and the left side is generated as a mirror after closing.

Symmetry applies to cube fill, triangle shell and plain triangle mode at the same time. If bending regions are used after enabling symmetry, they are mirrored as well.

Even if a bend selection was painted before symmetry was enabled, turning symmetry on mirrors the bend columns to the other side, so the two halves never differ in depth and the center seam is not pulled apart. Endpoints within one cell of the center line snap to the axis.

The symmetric triangle shell generates one set of mesh data on the right and mirrors the same vertices and triangle connectivity to the left, so the two halves never get different triangle topology or fill holes.

## Local bending

1. Draw and close an outline first.
2. Set `Bend amount (along Z)`; positive and negative values bend in opposite directions.
3. Set `Bend transition width`. Larger values spread the ease-in and ease-out across more columns; the default is 4 cells.
4. Decide whether to enable `Return to straight after bending`:
   - Enabled: bend in gradually, then smoothly return to the original direction.
   - Disabled: bend to the target amount and keep it until the model edge; the result is a one-way slope.
5. Click `Bend Selection`.
6. Paint the columns that should bend on the grid; hold Alt to erase.
7. Click the button again to leave bend-selection mode, then generate.

Bending adds ease-in and ease-out regions on both sides of the selection and offsets each column with a smooth curve, so the deadline never kinks abruptly. Cubes, inner cubes in hybrid mode and the triangle shell all follow the same bend direction. The whole group is selected automatically after generation.

## Local width

1. Set `Local width factor`: above 1 widens, below 1 narrows.
2. Set `Width transition width (cells)` to control the smooth transition on both sides of the selection.
3. Click `Width Selection` and paint the columns to adjust; hold Alt to erase.
4. Click the button again to leave width-selection mode, then generate.

The width selection stretches or squeezes the model smoothly along the horizontal direction instead of cutting it. When mirror symmetry is enabled, the width selection is mirrored automatically. `Clear Width` removes all width regions.

## Setting cubes or triangles by position

Choose `Per-position hybrid (cube/triangle)` as the generation mode:

1. Set `Per-position hybrid: default region` to `Default cube` in most cases.
2. Set `Region selection: mark as` to `Triangle`, click `Region Selection` and paint the blade edge.
3. Hold Alt to erase region marks.
4. Click `Clear Regions` to remove all region marks.
5. After generation, unmarked cells are cubes and cells marked as triangles use triangle faces — useful for a cube blade body with a triangle edge.

You can also set the default region to triangle and mark specific positions as cubes instead. Region marks support mirror symmetry, bending and local width.

Adjacent triangle regions are merged into one continuous area before the mesh is generated. Two triangle cells share an edge or surface instead of each closing separately and only touching at one vertex, which makes them much better for connected blade edges.

## Viewport points (2 points = line, 3 = face, 4 = box)

1. In the `视口取点` (viewport points) section at the bottom of the dialog, press `在视口取点`. The dialog hides and a floating point bar appears at the top of the screen.
2. Click directly in the Blockbench 3D viewport to place vertices. Coordinates snap to the grid; clicking an existing cube sticks to its surface, while clicking empty space places the point on the current drawing plane.
3. 2 points produce a thin cuboid line (width from `线宽 / 最小厚度`), 3 points produce a triangle face (needs a format with mesh support such as Generic Model / Free Model), and 4 points produce the box enclosing them (a zero-thickness axis is expanded to the minimum thickness).
4. With fewer than 4 points, press `生成` in the floating bar; `撤销` removes the last point and `清空` removes all. The 4th point generates the box automatically and clears the list so you can continue with the next shape.
5. Press `返回面板` to leave point mode and return to the dialog.

Note: in point mode the left mouse button is reserved for placing points; use the right or middle mouse button, or return to the panel, when you need to orbit or pan the view.

## Format limitations

The Java Block/Item export format only contains cuboids and no arbitrary triangle meshes. The plugin disables triangle and hybrid modes in Java Block/Item so shapes never look correct in Blockbench but vanish after export.

The cube-only mode still preserves the outline in Java Block/Item. When you need rounded shapes, use triangle or hybrid modes in `Generic Model / Free Model`.

If you need triangle faces or hybrid models, create a `Generic Model / Free Model` project and export via OBJ, GLTF or whatever the project supports.

## Tips

- Draw wide enough to enclose at least one cell; very thin lines may leave no fillable area.
- Cube mode merges adjacent cells by default, which greatly reduces the component count.
- After generation you can keep moving, rotating, scaling, texturing or animating the result inside Blockbench.
