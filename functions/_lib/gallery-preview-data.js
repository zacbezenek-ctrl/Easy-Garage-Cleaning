// Internal test fixtures, not customer projects. Keep provenance separate from presentation.
// Copied from PR 63 at 5ea44a1509ca3bcb301d2ceb37e4a5301ce86b7c.
// Seventeen previously approved pairs and seven pending visual review; no review status changed here.
export const galleryPreviewProvenance = Object.freeze({
  type: 'ai-generated-concept', audience: 'internal', customerProject: false,
  sourceCommit: '5ea44a1509ca3bcb301d2ceb37e4a5301ce86b7c',
  requestedModel: 'nano_banana_pro', reportedModel: 'nano_banana_2',
  note: 'Provider model identity is not independently verified. Internal inclusion is not publication approval.'
});
const rows = [
 ['01-family-garage','Room for the family car','9a198d37','25b7e833','approved'],
 ['02-single-car','Small garage, useful space','710f44c8','5c52c6b7','approved'],
 ['03-four-bikes','A place for the bikes','1f051c62','6e8fe44e','approved'],
 ['04-working-bench','Bring the workbench back','1a62e106','124cceaa','approved'],
 ['05-seasonal-storage','Find the holiday boxes','96301f00','a2094e80','approved'],
 ['06-camping-gear','Ready for the next trip','d8d69a3d','9c526c89','approved'],
 ['07-garden-tools','The garden gear, sorted','b29fc36f','d5df4eac','approved'],
 ['08-bulky-cleanout','Remove what no longer belongs','66e0be48','8d671323','approved'],
 ['09-moving-boxes','Unpack the garage','adb3318d','f5f7d407','approved'],
 ['10-downsizing','Keep the things that matter','8ca74d2b','7bbb2904','approved'],
 ['11-sports-family','Practice-day storage','69803493','f8d3bebf','pending'],
 ['12-ski-snowboard','Winter gear without the pile','facdb107','8db719a7','approved'],
 ['13-home-workout','Make space to move','90e23e23','c069b8bd','approved'],
 ['14-small-tool-wall','Tools off the floor','153ccc4c','f9aaeee2','approved'],
 ['15-light-seasonal-bins','Seasonal storage with a plan','6b077d6e','6188fb94','approved'],
 ['16-utility-access','A clear route to the door','8fefe176','93be887c','approved'],
 ['17-reuse-shelves','Work with what you own','caddc66e','1ebc139a','approved'],
 ['18-tandem-garage','A path through a long garage','429e8169','4f7cede1','approved'],
 ['19-third-bay','Give the extra bay a purpose','57cd8124','3bda53b6','pending'],
 ['20-older-detached','A fresh start, without a remodel','49377942','895b58ff','pending'],
 ['21-entry-zone','An easier way into the house','1ae9f5e1','7b26694a','pending'],
 ['22-hobby-storage','Make your hobby easy to reach','eb006fe8','39cbe120','pending'],
 ['23-winter-parking','Bring the parking space back','824e88ae','f012bda5','pending'],
 ['24-complete-organization','A place for the everyday things','7a807562','3fff8425','pending']
];
export const galleryPreviewPairs = Object.freeze(rows.map(([id,title,beforeId,afterId,reviewStatus]) => Object.freeze({
 id,title,reviewStatus,type:'concept',
 before:`/internal-gallery-assets/images/${id}-before-${beforeId}.webp`,
 after:`/internal-gallery-assets/images/${id}-after-${afterId}.webp`
})));
export const galleryPreviewAssetPaths = new Set([
 '/internal-gallery-assets/gallery.css', '/internal-gallery-assets/gallery.js',
 ...galleryPreviewPairs.flatMap(pair => [pair.before,pair.after])
]);
