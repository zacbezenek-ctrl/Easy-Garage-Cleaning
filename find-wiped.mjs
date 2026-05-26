import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const app = initializeApp({
  apiKey:            "AIzaSyA8g4UAW4P4bsCrQNZhUe81CbC7BvjJbNc",
  authDomain:        "egcw-1ec83.firebaseapp.com",
  projectId:         "egcw-1ec83",
  storageBucket:     "egcw-1ec83.firebasestorage.app",
  messagingSenderId: "763340109795",
  appId:             "1:763340109795:web:ac203b3eb71831fa4ed2d6"
});
const db = getFirestore(app);

const snap = await getDocs(collection(db, 'leads'));
console.log(`Total leads: ${snap.size}\n`);

const wiped = [];
const ok = [];

snap.forEach(d => {
  const data = d.data();
  if (!data.name && !data.firstName) {
    wiped.push({ id: d.id, fields: Object.keys(data) });
  } else {
    ok.push(d.id);
  }
});

console.log(`OK (have name): ${ok.length}`);
console.log(`Wiped (no name): ${wiped.length}\n`);

if (wiped.length) {
  console.log('Wiped documents:');
  wiped.forEach(w => console.log(`  ${w.id}  fields: [${w.fields.join(', ')}]`));
}

process.exit(0);
