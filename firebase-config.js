// Firebase initialization for Newman Phone Line.
// This only sets up the connection — auth + Firestore are used for three things:
//   1. the shared "phone number" directory (so family members can find each other
//      and see each other's name/bio/color when a call comes in)
//   2. call signaling (passing WebRTC offer/answer/candidates back and forth)
//   3. presence isn't tracked at all — there is no "online" list, just numbers.
// Contacts, call history, and your saved profile all live on-device (localStorage),
// never in Firebase. See README.md for the Firestore security rules to paste in.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  addDoc,
  query,
  where,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDftm-tfSRisUpspBCwYYEeM8SuiecuUSQ",
  authDomain: "phone-2f357.firebaseapp.com",
  projectId: "phone-2f357",
  storageBucket: "phone-2f357.firebasestorage.app",
  messagingSenderId: "611636737087",
  appId: "1:611636737087:web:2e2676848c3eccce27348a",
  measurementId: "G-7QWXKEPZE2",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        resolve(user);
      } else {
        signInAnonymously(auth).catch(reject);
      }
    });
  });
}

// Expose everything the app needs on window so app.js (a plain module) can use it
// without juggling a second bundler/import graph.
window.NPL_FIREBASE = {
  app,
  auth,
  db,
  ensureSignedIn,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  addDoc,
  query,
  where,
  runTransaction,
  serverTimestamp,
};

window.dispatchEvent(new Event("npl-firebase-ready"));
