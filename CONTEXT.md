# CONTEXTE PROJET : BOURSE À LA BIÈRE (foyer-bourse)

## ARCHITECTURE & RÈGLES STRICTES
- Stack : HTML5, CSS3, JavaScript ES6 (Modules purs / CDN), Firebase Realtime Database v13+, Chart.js.
- Zéro Backend : Pas de serveur Node.js / Python. Le Dashboard PC agit comme le "Cerveau" centralisateur.
- Événements (Event Sourcing) :
  - Les téléphones (App Manager) lisent `prix_actuels` et exécutent un `push` dans `journal_ventes`. Aucun calcul de prix sur mobile.
  - Le Dashboard PC écoute `journal_ventes`, calcule les nouveaux prix selon l'algorithme et met à jour le nœud `prix_actuels` sur Firebase.

## CONFIGURATION FIREBASE (SDK Web ES Modules)
```javascript
import { initializeApp } from "[https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js](https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js)";
import { getDatabase, ref, push, onValue, set } from "[https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js](https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js)";

const firebaseConfig = {
  apiKey: "AIzaSyAGIUmCq2Brg_X4d3ONCi1P2yESd06quH8",
  authDomain: "foyer-bourse.firebaseapp.com",
  databaseURL: "[https://foyer-bourse-default-rtdb.europe-west1.firebasedatabase.app](https://foyer-bourse-default-rtdb.europe-west1.firebasedatabase.app)",
  projectId: "foyer-bourse",
  storageBucket: "foyer-bourse.firebasestorage.app",
  messagingSenderId: "1036825757284",
  appId: "1:1036825757284:web:43555fc57d6b69f4c7c171"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);