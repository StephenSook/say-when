# Brain model asset

`web/public/models/brain.glb` is the template brain for Screen 1. It is one clean outer surface
(cortex, cerebellum and brainstem) built from the Human Reference Atlas male brain, so the shader
can light soft patches under C3 and C4 from each vertex's direction from the center.

## Source and license

- Model: "3D Reference Organ for Brain, Male", version v1.3, Human Reference Atlas (HRA), HuBMAP.
- Creators: Kristen Browne and Heidi Schlehlein. Reviewer: Song-Lin Ding. Project lead: Katy Börner.
- DOI: https://doi.org/10.48539/HBM929.XKCL.339
- NIH 3D entry: https://3d.nih.gov/entries/3DPX-020960 ("Brain, Male", created by HRA, CC BY badge;
  its Attribution Instructions field reads "National Institute of Allergy and Infectious Disease").
- File: https://cdn.humanatlas.io/digital-objects/ref-organ/brain-male/v1.3/assets/3d-vh-m-allen-brain.glb
  (11,977,312 bytes, sha256 `2b9ad5b53e40e9f0936da74f7be38d2eed15604e26358c3870a0ea13499b9a35`).
- Metadata: https://cdn.humanatlas.io/digital-objects/ref-organ/brain-male/v1.3/metadata.json
- License: Creative Commons Attribution 4.0 International (CC BY 4.0),
  https://creativecommons.org/licenses/by/4.0/ (the HRA metadata says the license changed to CC BY 4.0
  in v1.3).
- Underlying data: Allen Human Reference Atlas - 3D, 2020 (Ding et al. 2016,
  https://doi.org/10.1002/cne.24080). Per HRA, one hemisphere's 141 structures were mirrored to make a
  whole brain and resized to fit the Visible Human Male and Female.
- HRA funding listed in the metadata: NIH awards OT2OD033756 and OT2OD026671.

### Attribution line to show on screen (exact text)

```
Brain model: "3D Reference Organ for Brain, Male" v1.3 by Kristen Browne and Heidi Schlehlein, Human Reference Atlas (HuBMAP), via NIH 3D (NIAID). CC BY 4.0. Modified.
```

Suggested links: the title to https://doi.org/10.48539/HBM929.XKCL.339, "NIH 3D" to
https://3d.nih.gov/entries/3DPX-020960, and "CC BY 4.0" to https://creativecommons.org/licenses/by/4.0/.
"Modified" is required by CC BY because we rebuilt the outer surface, simplified, re-oriented and
rescaled the model. The same credit is stored in the GLB's `asset.copyright` field.

HRA's own citation text, for a credits page or a write-up:
Kristen Browne; Heidi Schlehlein. 2023. 3D Reference Organ for Brain, Male v1.3.
https://doi.org/10.48539/HBM929.XKCL.339.

## How to rerun

The script reads the downloaded GLB and writes the output. It never downloads anything. Run it from a
scratch folder so `node_modules` does not land in the repo (the repo `.gitignore` already ignores any
`node_modules/` folder if you do install here). Tested with Node 26.12.1; peak memory about 3 GB;
about 45 seconds.

```sh
mkdir -p /tmp/brain-asset/download /tmp/brain-asset/tools
curl -L -o /tmp/brain-asset/download/3d-vh-m-allen-brain.glb \
  https://cdn.humanatlas.io/digital-objects/ref-organ/brain-male/v1.3/assets/3d-vh-m-allen-brain.glb
shasum -a 256 /tmp/brain-asset/download/3d-vh-m-allen-brain.glb   # expect 2b9ad5b5...9a35
cp tools/brain-asset/package.json tools/brain-asset/prepare-brain.mjs /tmp/brain-asset/tools/
cd /tmp/brain-asset/tools && npm install --ignore-scripts
node prepare-brain.mjs ../download/3d-vh-m-allen-brain.glb /path/to/say-when/web/public/models/brain.glb
node prepare-brain.mjs --verify-only /path/to/say-when/web/public/models/brain.glb
npx gltf-transform validate /path/to/say-when/web/public/models/brain.glb
```

The build is deterministic: two runs gave byte-identical files (sha256
`25011012dd6471729b4b1d51c2b4a7be896b0ba8ccfe6b5997b6fbacfb4e74dc`). Options (`--voxel`, `--blur`,
`--smooth`, `--target-tris`, `--max-error`, `--debug`) are described at the top of the script; the
defaults made the committed file.

Pinned packages: @gltf-transform/core, /extensions and /functions 4.5.1, meshoptimizer 1.3.0, and
@gltf-transform/cli 4.5.1 (only for `inspect` and `validate`).

## What the script does

1. Reads all 283 meshes, bakes node transforms (all are identity in this file) and converts meters
   to millimeters.
2. Leaves out 7 thin appendages: both olfactory bulbs, both olfactory tracts, both optic tracts and
   the optic chiasm.
3. Voxelizes the rest (651,710 triangles) at 0.4 mm and flood fills the outside. Only the 134,366
   source triangles that touch the outside shape the surface, so the inside of every deep structure
   is gone.
4. Rebuilds that outer surface as one closed mesh: narrow band signed distance to those triangles,
   one light blur of the field (removes voxel saw teeth along sulcal lips and softens the slice
   terracing of the atlas), marching tetrahedra, drop 274 tiny separate pieces (273 enclosed voids,
   81.8 mm3 in total, and one empty sliver), 3 Taubin smoothing passes. Result before
   simplification: 8,053,196 triangles, 0 boundary edges, 0 non-manifold edges.
5. Rotates (proper rotation only), simplifies with meshoptimizer (error 0.061 mm), removes 183 pairs
   of coincident opposite triangles the simplifier made in thin folds, splits 102 pinched vertices,
   computes smooth area weighted normals, centers the bounding box and scales Z to 2.0.
6. Writes one node, one mesh, one primitive, one material, compressed with EXT_meshopt_compression.

Why rebuild instead of merging the parcels: the atlas parcels do not share vertices. Merging the
outer faces of the parcels left 22,578 open boundary edges (cracks of about 0.8 mm median width
between neighbors, measured as the median distance from a parcel's edge vertex to the nearest edge
vertex of another parcel), which show up as seams and see-through hairlines. The rebuilt shell has
none.

## Measured facts about the source

Checked against the teammate notes: all true. 11,977,312 bytes (about 12 MB); 286 nodes (root
`Allen_brain`, `Allen_brain_Hemisphere_L`, `Allen_brain_Hemisphere_R`, 283 mesh nodes); 324,855
vertices; 656,268 triangles; POSITION and NORMAL only, no UVs; 2 materials (`brain_mat`, and
`retina` used only by the optic chiasm); units are meters; body frame bounding box min
(-0.06828, 0.75652, -0.08467) max (0.06810, 0.90262, 0.08236), so y is about 0.757 to 0.903.

Orientation in the source (millimeters):

- Anterior is +Z. Olfactory bulbs sit at z 58 to 67, gyrus rectus at z 23 to 73, temporal pole
  centroids at z +36.6 and +39.5, superior frontal gyrus reaches z +77.7. The occipital poles sit at
  z -84.7 to -64.3 and the cerebellar hemispheres at z -61.9 to -0.7 (posterior and low).
- Superior is +Y. Superior frontal and precentral gyri reach y 902.6 and 900.4 (the top); the
  medulla and the bottom of the cerebellum reach y 756.5 to 758 (the bottom).
- `_L` nodes are at negative X: 139 of 141 `_L` centroids have x < 0 (the two exceptions are midline
  structures at x = +0.3 mm); vertex weighted mean x is -24.5 mm for `_L` and +25.7 mm for `_R`.
- With +Y up and +Z anterior in glTF's right handed frame, the subject's left should be at +X, so
  the source's `_L` geometry sits on the anatomical right. In other words the labels and the
  geometry disagree by a mirror. It does not matter for this asset (see below).

Mirror check: the halves are exact geometric mirrors. All 141 `_L`/`_R` pairs have identical vertex
counts. Reflecting every `_L` vertex across the fitted plane puts it within 0.050 mm of an `_R`
vertex (median 0.022 mm). The plane normal is (0.9989, -0.0259, -0.0394), tilted 2.70 degrees from
the X axis, and passes within about 1 mm of x = 0 at brain height. Vertex order differs inside some
pairs, so index by index comparison does not work.

Name quirks:

- Six `_L` meshes are children of `Allen_brain_Hemisphere_R` (hypothalamus, midbrain tegmentum, red
  nucleus, inferior colliculus, mammillary region, subthalamic nucleus), so the hemisphere groups
  have 135 and 147 children.
- Some names near the end of each hemisphere list do not match their geometry. Examples (left side):
  `frontal_pole_L` sits at z -62.8 to +2.7 and is fully hidden; `frontomarginal_gyrus_L` lies on the
  underside of the temporal lobe (y 786 to 811, z -6 to +41); `posteroventral_putamen_L` is a
  5,443 mm2 patch of medial superior frontal cortex; `atrium_of_lateral_ventricle_L` is on the medial orbital surface;
  `paracingulate_gyrus_L` sits at the frontal pole; `perirhinal_gyrus_rostral_part_of_FuGt_L` is
  posterior and hidden. That is why the script selects by geometry (touches the outside or not), not
  by name.

Node groups (by name, with the mislabeled ones placed by geometry), and how much of the outer
surface each group makes:

| Group | Nodes | Touch the outside | Share of outer surface area |
| --- | --- | --- | --- |
| Cerebral cortex (gyri, poles, opercula, insula, cingulate, parahippocampal, ...) | 104 | 104 | 77.8% |
| Cerebellum (vermis, paravermis, lateral hemispheres) | 6 | 6 | 15.5% |
| Brainstem (pons, medulla, midbrain, peduncles, colliculi, olive) | 24 | 24 | 3.1% |
| Deep and subcortical (thalamus, basal ganglia, amygdala, hippocampus, ventricles, hypothalamus, commissures, ...) | 138 | 61 | 2.2% |
| White matter (forebrain, hindbrain) | 4 | 4 | 1.4% |
| Appendages (olfactory bulbs and tracts, optic tracts, optic chiasm) | 7 | dropped first | 0% |

Kept: cortex, cerebellum and brainstem in full (their outer surface). Dropped: all 7 appendages and
the inside of every deep structure and of the white matter; 77 deep nodes contribute nothing. The
2.2% plus 1.4% that remain are small patches where those structures are the true outer surface: the
corpus callosum and the medial thalamus along the midline gap between the hemispheres, white matter
where the hemispheres meet the brainstem and around the cerebellar peduncles, the fourth ventricle
between cerebellum and brainstem, and the hypothalamus and mammillary bodies on the underside.
Dropping them too would leave holes into an empty inside.

## Measured facts about the output

- File: 1,606,240 bytes. Khronos glTF validator: 0 errors, 0 warnings (2 info notes: it cannot
  validate EXT_meshopt_compression, and it flags the meshopt fallback buffer as unused).
- 1 node (`Brain`, identity transform), 1 mesh (`Brain`), 1 primitive, 1 material (`brain`).
- 124,616 vertices, 249,616 triangles, uint32 indices.
- Attributes: POSITION float32 (already in final units) and NORMAL as normalized int8 with the meshopt
  octahedral filter. Extensions used and required: EXT_meshopt_compression, KHR_mesh_quantization.
  No Draco. three.js: GLTFLoader with MeshoptDecoder (drei `useGLTF(url, false, true)`).
- Bounding box min (-0.819389, -0.870698, -1.000000), max (0.819389, 0.870698, 1.000000);
  center (0, 0, 0); Z extent exactly 2.0.
- Scale: 0.01203525 units per mm (the rebuilt shell is 166.18 mm front to back), so 1 unit is about
  83.1 mm.
- Frame: anterior -Z, superior +Y, midline plane at X = 0. The rotation is proper (determinant +1),
  rows (-0.99889, 0.02589, 0.03939), (0.02587, 0.99966, -0.00102), (-0.03940, 0.00000, -0.99922)
  applied to source millimeters. It is the 180 degree turn about Y plus a 2.7 degree correction that
  puts the mirror plane exactly on X = 0.
- After that rotation the `_L` geometry lands at +X (centroid X = +45.8 mm before centering), which is
  the subject's right in this frame. No mirroring was applied. Because the two halves are exact
  mirror copies, the shape has no handedness: treat -X as the subject's left (C3) and +X as the
  subject's right (C4), and ignore the source's L and R names.
- Front versus back check: in the slice z from -1.0 to -0.8 (frontal pole) y spans -0.135 to 0.581;
  in z from 0.6 to 0.8 y spans -0.765 to 0.744 because the cerebellum hangs below the occipital lobe.
  The highest vertex is at y +0.871 near the midline (x -0.09), the lowest at y -0.871 under a
  cerebellar hemisphere.
- Mesh quality: closed 2-manifold (0 boundary edges, 0 non-manifold edges), outward winding (signed
  volume +2.554 cubic units), surface area 20.75 square units split 10.37 / 10.38 between +X and -X,
  area centroid x = -0.0003. The simplifier spent more triangles on +X (132,797) than on -X
  (116,819); the shape is symmetric, only the tessellation density differs.
- Risks: the sulci are softer than in the source (blur and smoothing), and sulci narrower than about
  0.4 mm are closed. Normals are 8 bit, so code that reads `geometry.attributes.normal.array`
  directly gets an Int8Array with a stride of 4; three.js materials and `getX` handle it.
