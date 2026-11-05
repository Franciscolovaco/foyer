const productConfiguration = {
  "blonde-pression": {
    firebaseId: "biere_1_blonde",
    label: "Blonde Pression"
  },
  "ipa-locale": {
    firebaseId: "biere_2_ipa",
    label: "IPA Locale"
  },
  "fruits-rouges": {
    firebaseId: "biere_3_rouge",
    label: "Fruits Rouges"
  }
};

let connectedManagerName = "";
let lastSaleId = null;
let db = null;
let auth = null;
let firebaseDatabase = null;
let firebaseAuthModule = null;

const loginSection = document.querySelector("#login-section");
const loginForm = document.querySelector("#login-form");
const managerEmailInput = document.querySelector("#manager-email");
const managerPasswordInput = document.querySelector("#manager-password");
const venteSection = document.querySelector("#vente-section");
const managerNameElement = document.querySelector("#manager-name");
const logoutButton = document.querySelector("#logout-button");
const cancelLastSaleButton = document.querySelector("#cancel-last-sale-button");
const crashMarketButton = document.querySelector("#crash-market-button");
const endCrashButton = document.querySelector("#end-crash-button");
const beerGrid = document.querySelector("#beer-grid");

function showError(message) {
  window.alert(message);
}

async function loadFirebase() {
  if (db && firebaseDatabase && auth && firebaseAuthModule) {
    return;
  }

  const [firebaseConfig, databaseModule, authModule] = await Promise.all([
    import("../firebase-config.js"),
    import("https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js"),
    import("https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js")
  ]);

  db = firebaseConfig.db;
  auth = firebaseConfig.auth;
  firebaseDatabase = databaseModule;
  firebaseAuthModule = authModule;
}

function getProductConfiguration(productId) {
  const product = productConfiguration[productId];

  if (!product) {
    throw new Error(`Produit inconnu : ${productId}`);
  }

  return product;
}

function getQuantityElement(productId) {
  return document.querySelector(`[data-quantity-for="${productId}"]`);
}

function setQuantity(productId, quantity) {
  const quantityElement = getQuantityElement(productId);

  if (!quantityElement) {
    throw new Error(`Élément de quantité introuvable pour : ${productId}`);
  }

  quantityElement.textContent = String(Math.max(1, quantity));
}

function getQuantity(productId) {
  const quantityElement = getQuantityElement(productId);
  const quantity = Number.parseInt(quantityElement?.textContent ?? "", 10);

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Quantité invalide pour : ${productId}`);
  }

  return quantity;
}

function formatPrice(price) {
  const numericPrice = Number(price);

  if (!Number.isFinite(numericPrice)) {
    throw new Error(`Prix invalide reçu depuis Firebase : ${price}`);
  }

  return `${numericPrice.toFixed(2)} €`;
}

function updateDisplayedPrices(prices) {
  for (const [productId, product] of Object.entries(productConfiguration)) {
    const priceElement = document.querySelector(`[data-price-for="${productId}"]`);

    if (!priceElement) {
      console.error(`Élément de prix introuvable pour : ${productId}`);
      continue;
    }

    const price = prices[product.firebaseId];

    if (price === undefined || price === null) {
      console.error(`Prix absent dans prix_actuels pour : ${product.firebaseId}`);
      continue;
    }

    try {
      priceElement.textContent = formatPrice(price);
    } catch (error) {
      console.error(`Impossible d'afficher le prix de ${product.label}.`, error);
    }
  }
}

function showVenteSection() {
  loginSection.style.display = "none";
  venteSection.hidden = false;
  venteSection.style.display = "block";
  managerNameElement.textContent = connectedManagerName;
}

function showLoginSection() {
  venteSection.hidden = true;
  venteSection.style.display = "none";
  loginSection.style.display = "";
}

async function registerSale(productId) {
  await loadFirebase();
  const product = getProductConfiguration(productId);
  const quantity = getQuantity(productId);
  const saleReference = await firebaseDatabase.push(firebaseDatabase.ref(db, "journal_ventes"), {
    manager: connectedManagerName,
    biere: product.firebaseId,
    quantite: quantity,
    action: "vente",
    timestamp: Date.now()
  });

  lastSaleId = saleReference.key;
  setQuantity(productId, 1);
}

async function cancelLastSale() {
  if (!lastSaleId) {
    return;
  }

  await loadFirebase();

  await firebaseDatabase.push(firebaseDatabase.ref(db, "journal_ventes"), {
    manager: connectedManagerName,
    reference_annulation: lastSaleId,
    action: "annulation",
    timestamp: Date.now()
  });

  lastSaleId = null;
}

async function triggerMarketCrash() {
  if (!connectedManagerName) {
    throw new Error("Aucun manager connecté.");
  }

  await loadFirebase();

  await firebaseDatabase.push(firebaseDatabase.ref(db, "journal_ventes"), {
    manager: connectedManagerName,
    action: "krach_boursier",
    timestamp: Date.now()
  });
}

// LOGIQUE D'AUTHENTIFICATION FIREBASE
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = managerEmailInput.value.trim();
  const password = managerPasswordInput.value;

  if (!email || !password) {
    showError("Veuillez remplir tous les champs.");
    return;
  }

  try {
    await loadFirebase();
    // Tentative de connexion via Firebase Auth
    await firebaseAuthModule.signInWithEmailAndPassword(auth, email, password);
    
    // On extrait le prénom de l'email (ex: "camille" depuis "camille@foyer.local")
    let extractedName = email.split('@')[0];
    connectedManagerName = extractedName.charAt(0).toUpperCase() + extractedName.slice(1);
    
    showVenteSection();
  } catch (error) {
    console.error("Erreur de connexion", error);
    showError("Identifiants incorrects. Vérifiez l'email et le mot de passe.");
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await loadFirebase();
    await firebaseAuthModule.signOut(auth);
  } catch (error) {
    console.error("Erreur déconnexion", error);
  }

  connectedManagerName = "";
  lastSaleId = null;
  loginForm.reset();
  showLoginSection();
});

beerGrid.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");

  if (!button) {
    return;
  }

  const productId = button.closest("[data-product-id]")?.dataset.productId;

  if (!productId) {
    console.error("Produit introuvable pour cette action.");
    return;
  }

  try {
    if (button.dataset.action === "increase-quantity") {
      setQuantity(productId, getQuantity(productId) + 1);
    } else if (button.dataset.action === "decrease-quantity") {
      setQuantity(productId, getQuantity(productId) - 1);
    } else if (button.dataset.action === "sell") {
      await registerSale(productId);
    }
  } catch (error) {
    console.error("L'opération n'a pas pu être effectuée.", error);
    showError("Une erreur est survenue. Vérifie la connexion puis réessaie.");
  }
});

cancelLastSaleButton.addEventListener("click", async () => {
  if (!lastSaleId) {
    showError("Aucune vente récente à annuler.");
    return;
  }

  try {
    await cancelLastSale();
  } catch (error) {
    console.error("L'annulation n'a pas pu être enregistrée.", error);
    showError("L'annulation n'a pas pu être enregistrée. Réessaie.");
  }
});

crashMarketButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Déclencher un KRACH BOURSIER ? Tous les prix vont passer au minimum."
  );

  if (!confirmed) {
    return;
  }

  try {
    await triggerMarketCrash();
  } catch (error) {
    console.error("Le krach n'a pas pu être déclenché.", error);
    showError("Le krach n'a pas pu être déclenché. Réessaie.");
  }
});

endCrashButton.addEventListener("click", async () => {
  if (!connectedManagerName) return;
  
  const confirmed = window.confirm("Arrêter le Krach et reprendre les cours normaux ?");
  if (!confirmed) return;

  try {
    await loadFirebase();
    await firebaseDatabase.push(firebaseDatabase.ref(db, "journal_ventes"), {
      manager: connectedManagerName,
      action: "fin_krach",
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("Impossible d'arrêter le krach.", error);
    showError("Erreur lors de l'arrêt du krach.");
  }
});

async function listenToCurrentPrices() {
  try {
    await loadFirebase();

    firebaseDatabase.onValue(
      firebaseDatabase.ref(db, "prix_actuels"),
      (snapshot) => {
        const prices = snapshot.val();

        if (!prices || typeof prices !== "object") {
          console.error("Le nœud prix_actuels est absent ou invalide.");
          return;
        }

        updateDisplayedPrices(prices);
      },
      (error) => {
        console.error("Impossible de lire les prix actuels depuis Firebase.", error);
      }
    );
  } catch (error) {
    console.error("Firebase n'est pas disponible.", error);
  }
}

listenToCurrentPrices();
