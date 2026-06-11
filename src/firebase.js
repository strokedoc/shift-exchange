// Fill in these values from your Firebase project console:
// Firebase Console → Project Settings → Your apps → SDK setup → Config
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyAwZGuLFDjmI80EnYU0eZSLgwV5Tvv0sCI",
  authDomain: "yearly-shift-exchange.firebaseapp.com",
  databaseURL: "https://yearly-shift-exchange-default-rtdb.firebaseio.com",
  projectId: "yearly-shift-exchange",
  storageBucket: "yearly-shift-exchange.firebasestorage.app",
  messagingSenderId: "1084645611753",
  appId: "1:1084645611753:web:d59e1e3f3c3537c25d7878",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
