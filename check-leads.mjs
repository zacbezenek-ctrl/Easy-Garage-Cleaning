import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey:            "AIzaSyA8g4UAW4P4bsCrQNZhUe81CbC7BvjJbNc",
  authDomain:        "egcw-1ec83.firebaseapp.com",
  projectId:         "egcw-1ec83",
  storageBucket:     "egcw-1ec83.firebasestorage.app",
  messagingSenderId: "763340109795",
  appId:             "1:763340109795:web:ac203b3eb71831fa4ed2d6"
});
const db = getFirestore(app);

const phones = [
  "15759108847", "13072560192", "13033967604", "13039296977",
  "19729775004", "19018342688", "17608554127", "19704120256",
  "13037720815", "13037461561", "14158182648", "17204549374",
];

for (const id of phones) {
  const snap = await getDoc(doc(db, 'leads', id));
  if (snap.exists()) {
    const d = snap.data();
    console.log(`${id}  name=${d.name || 'MISSING'}  status=${d.status || 'MISSING'}  source=${d.source || 'MISSING'}  phone=${d.phone || 'MISSING'}`);
  } else {
    console.log(`${id}  — DOCUMENT NOT FOUND`);
  }
}

process.exit(0);
