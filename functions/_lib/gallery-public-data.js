import { galleryPreviewPairs } from './gallery-preview-data.js';

// Public-gallery presentation only. Original staff fixtures and provenance remain unchanged.
// These are visually reviewed fictional concepts, never customer projects or promised outcomes.
export const galleryPublicVersion = '20260923-ideal-storage-v2';
const featured = [
 ['24-complete-organization','A complete garage turnaround','3aaa31c3','24c80cfd'],
 ['01-family-garage','Room for the family car','ef560540','2a7e8e71'],
 ['23-winter-parking','Bring the parking space back','53ac7d59','60b1b0c1'],
 ['04-working-bench','Bring the workbench back','f02eaf4e','0db15d3f'],
 ['05-seasonal-storage','Seasonal storage, finally sorted','d6db183c','d17b57ee'],
 ['09-moving-boxes','From moving boxes to useful storage','5db7e46d','ecd56e40'],
 ['03-four-bikes','Bikes, bins, and room to move','c74e854f','951c8c03'],
 ['02-single-car','Small garage. Serious storage.','4ec5dbd1','f1575b04']
];
export const galleryFeaturedIds = Object.freeze(featured.map(row => row[0]));
const originals = new Map(galleryPreviewPairs.map(pair => [pair.id,pair]));
const featuredPairs = featured.map(([id,title,beforeId,afterId],index) => {
 const original = originals.get(id);
 if (!original) throw new Error('Unknown featured gallery scene: '+id);
 return Object.freeze({
  id,title,type:'concept',customerProject:false,reviewStatus:'reviewed-concept',visualReviewPassed:true,
  featuredRank:index+1,revision:galleryPublicVersion,width:1168,height:880,
  keywords:original.title+' '+id+' black metal shelving steel racks yellow lid bins storage organization',
  before:`/gallery-ideal-assets/images/${id}-before-${beforeId}.webp`,
  after:`/gallery-ideal-assets/images/${id}-after-${afterId}.webp`
 });
});
const featuredIds = new Set(galleryFeaturedIds);
// Strongest storage-heavy transformations first; retain the other 16 distinct scenes below.
export const galleryPublicPairs = Object.freeze([
 ...featuredPairs,
 ...galleryPreviewPairs.filter(pair => !featuredIds.has(pair.id))
]);
