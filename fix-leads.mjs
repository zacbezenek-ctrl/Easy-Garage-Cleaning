import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey:            "AIzaSyA8g4UAW4P4bsCrQNZhUe81CbC7BvjJbNc",
  authDomain:        "egcw-1ec83.firebaseapp.com",
  projectId:         "egcw-1ec83",
  storageBucket:     "egcw-1ec83.firebasestorage.app",
  messagingSenderId: "763340109795",
  appId:             "1:763340109795:web:ac203b3eb71831fa4ed2d6"
});
const db = getFirestore(app);

const leads = [
  { phone: "+15759108847", name: "Sherri Mosley",              created: "2026-05-26T06:14:00-06:00" },
  { phone: "+13072560192", name: "Annette Hernandez",          created: "2026-05-25T10:21:00-06:00" },
  { phone: "+13033967604", name: "Todd Jordan",                created: "2026-05-25T07:21:00-06:00" },
  { phone: "+13039296977", name: "Ken Elliott",                created: "2026-05-25T06:04:00-06:00" },
  { phone: "+19729775004", name: "Nancy Bryant",               created: "2026-05-25T04:54:00-06:00" },
  { phone: "+19018342688", name: "Audrey & Christopher Hall",  created: "2026-05-24T20:15:00-06:00" },
  { phone: "+17608554127", name: "Dana DeLaurentis",           created: "2026-05-24T19:16:00-06:00" },
  { phone: "+19704120256", name: "Toni Theisen",               created: "2026-05-24T18:44:00-06:00" },
  { phone: "+13037720815", name: "Mary Coleman",               created: "2026-05-24T11:24:00-06:00" },
  { phone: "+13037461561", name: "Laren Michelle Pedersen",    created: "2026-05-24T10:05:00-06:00" },
  { phone: "+14158182648", name: "zachary bezenek",            created: "2026-05-23T18:49:00-06:00" },
  { phone: "+17204549374", name: "Kathy Lambie",               created: "2026-05-23T18:10:00-06:00" },
];

let ok = 0;
let fail = 0;

for (const l of leads) {
  const firstName = l.name.split(' ')[0];
  const data = {
    name:            l.name,
    firstName,
    phone:           l.phone,
    source:          "Facebook Ads (fb)",
    status:          "new",
    crmStatus:       "new",
    contactAttempts: 0,
    assignedTo:      "Tyler",
    createdAt:       new Date(l.created).toISOString(),
    updatedAt:       new Date().toISOString(),
  };

  const docId = l.phone.replace('+', '');
  try {
    await setDoc(doc(db, 'leads', docId), data, { merge: true });
    console.log(`OK  ${docId}  ${l.name}`);
    ok++;
  } catch (err) {
    console.error(`FAIL  ${docId}  ${l.name}  →  ${err.message}`);
    fail++;
  }
}

console.log(`\nDone: ${ok} updated, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
