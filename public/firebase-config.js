// Firebase auth + profile persistence, isolated from the game so that a CDN or
// network failure degrades gracefully to local (guest) profiles instead of
// breaking the page. All firebase access is dynamic-imported inside try/catch.

const firebaseConfig = {
  apiKey: 'AIzaSyBUbJCMQT8dZr2ytp9uVAYjvDn3kWbsrAs',
  authDomain: 'tankerz-f3a97.firebaseapp.com',
  projectId: 'tankerz-f3a97',
  storageBucket: 'tankerz-f3a97.firebasestorage.app',
  messagingSenderId: '598179726204',
  appId: '1:598179726204:web:83b1ed80031f67350e5af9',
  measurementId: 'G-0RWJJH168Y',
};

let auth = null;
let db = null;
let mods = null;       // { auth: <authModule>, fs: <firestoreModule> }
let ready = false;

async function init() {
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]);
    const app = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    db = fsMod.getFirestore(app);
    mods = { auth: authMod, fs: fsMod };
    ready = true;
  } catch (err) {
    console.warn('[firebase] unavailable — falling back to local profiles.', err);
    ready = false;
  }
  return ready;
}

export const firebaseReady = init();
export function isReady() { return ready; }

// --- auth ---------------------------------------------------------------
export function watchAuth(cb) {
  if (!ready) { cb(null); return () => {}; }
  return mods.auth.onAuthStateChanged(auth, cb);
}

export async function signUpEmail(email, password, name) {
  if (!ready) throw new Error('Login service unavailable. Try Guest mode.');
  const cred = await mods.auth.createUserWithEmailAndPassword(auth, email, password);
  if (name) {
    try { await mods.auth.updateProfile(cred.user, { displayName: name }); } catch (_) {}
  }
  return cred.user;
}

export async function signInEmail(email, password) {
  if (!ready) throw new Error('Login service unavailable. Try Guest mode.');
  const cred = await mods.auth.signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signInGoogle() {
  if (!ready) throw new Error('Login service unavailable. Try Guest mode.');
  const provider = new mods.auth.GoogleAuthProvider();
  const cred = await mods.auth.signInWithPopup(auth, provider);
  return cred.user;
}

export async function signOutUser() {
  if (!ready) return;
  try { await mods.auth.signOut(auth); } catch (_) {}
}

export function friendlyAuthError(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/invalid-email': return 'That email address looks invalid.';
    case 'auth/missing-password': return 'Please enter a password.';
    case 'auth/weak-password': return 'Password must be at least 6 characters.';
    case 'auth/email-already-in-use': return 'That email is already registered — try signing in.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Email or password is incorrect.';
    case 'auth/popup-closed-by-user': return 'Sign-in window was closed.';
    case 'auth/operation-not-allowed': return 'This sign-in method is not enabled in Firebase yet.';
    case 'auth/network-request-failed': return 'Network error — check your connection.';
    default: return (err && err.message) || 'Authentication failed.';
  }
}

// --- profile persistence (Firestore) ------------------------------------
export async function remoteLoad(uid) {
  if (!ready) return null;
  try {
    const ref = mods.fs.doc(db, 'users', uid);
    const snap = await mods.fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[firebase] profile load failed.', err);
    return null;
  }
}

export async function remoteSave(uid, profile) {
  if (!ready) return false;
  try {
    const ref = mods.fs.doc(db, 'users', uid);
    await mods.fs.setDoc(ref, profile, { merge: true });
    return true;
  } catch (err) {
    console.warn('[firebase] profile save failed.', err);
    return false;
  }
}

// --- local cache / guest store ------------------------------------------
export function localLoad(key) {
  try {
    const raw = localStorage.getItem('tankzers_profile_' + key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export function localSave(key, profile) {
  try { localStorage.setItem('tankzers_profile_' + key, JSON.stringify(profile)); } catch (_) {}
}
