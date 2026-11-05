import { db, auth } from "../firebase-config.js";
import {
  get,
  onChildAdded,
  onValue,
  ref,
  set
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

// === VARIABLES GLOBALES ===
let priceChart = null;
let isKrachActive = false;
let krachTimeoutId = null;

// Ignore les événements vieux de plus de 2 minutes au chargement
const startupTime = Date.now() - 120000;

// === NOUVEAUX PARAMÈTRES DE L'ALGORITHME ===
const HAUSSE_PAR_UNITE = 0.30;       // La bière vendue prend +0.30€
const BAISSE_TEMPORELLE = 0.05;      // Toutes les bières perdent 0.05€ avec le temps
const RABAIS_MYSTERE = 0.30;         // La "prime au risque" de la pinte mystère
const INTERVALLE_TEMPS = 15000;      // Le marché baisse toutes les 15 secondes

const parametresBieres = {};
const prixCourants = {};
const ventesTraitees = new Map();
const prixAvantDernierEvenement = {};

const chartColors = {
  biere_1_blonde: "#FFD60A",
  biere_2_ipa: "#FF9F0A",
  biere_3_rouge: "#FF453A",
  biere_4_mystere: "#BF5AF2" // Violet électrique
};

// === FONCTIONS UTILITAIRES ===
function getCurrentTimeLabel() {
  return new Date().toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function arrondirPrix(prix) {
  return Math.round((prix + Number.EPSILON) * 100) / 100;
}

// === GESTION DU GRAPHIQUE (CHART.JS) ===
function initChart(parametres, prixInitiaux) {
  const canvas = document.querySelector("#priceChart");

  if (!canvas) {
    throw new Error("Canvas #priceChart introuvable.");
  }

  if (typeof Chart === "undefined") {
    throw new Error("Chart.js n'est pas chargé.");
  }

  // Calcul des limites pour l'axe Y du graphique
  const limitesPrix = Object.values(parametres).reduce(
    (limites, biere) => ({
      min: Math.min(limites.min, Number(biere.prix_min)),
      max: Math.max(limites.max, Number(biere.prix_max))
    }),
    { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY }
  );

  if (!Number.isFinite(limitesPrix.min) || !Number.isFinite(limitesPrix.max)) {
    throw new Error("Les limites de prix sont invalides.");
  }

  canvas.style.backgroundColor = "transparent";
  const labelInitial = getCurrentTimeLabel();

  // Création des courbes pour chaque bière
  const datasets = Object.entries(parametres).map(([biere, configuration]) => ({
    label: configuration.nom || biere,
    biereId: biere,
    data: [Number(prixInitiaux[biere])],
    borderColor: chartColors[biere] || "#ffffff",
    backgroundColor: chartColors[biere] || "#ffffff",
    
    // Style spécifique pour la bière mystère (ligne plus fine et pointillée)
    borderWidth: biere === "biere_4_mystere" ? 2 : 4,
    borderDash: biere === "biere_4_mystere" ? [5, 5] : [],
    
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: 0,
    fill: false
  }));

  priceChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: [labelInitial],
      datasets
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { color: "#333333" },
          ticks: { color: "#d8d8d8", maxTicksLimit: 10 }
        },
        y: {
          min: limitesPrix.min,
          max: limitesPrix.max,
          grid: { color: "#333333" },
          ticks: {
            color: "#d8d8d8",
            callback: (value) => `${Number(value).toFixed(2)} €`
          }
        }
      },
      plugins: {
        legend: {
          labels: {
            color: "#f2f4f3",
            font: {
              family: "Montserrat, Segoe UI, sans-serif",
              weight: "600"
            }
          }
        }
      }
    }
  });
}

function updateChart(nouveauxPrix) {
  if (!priceChart) {
    return;
  }

  priceChart.data.labels.push(getCurrentTimeLabel());

  for (const dataset of priceChart.data.datasets) {
    dataset.data.push(Number(nouveauxPrix[dataset.biereId]));

    // Garde seulement les 30 derniers points pour la fluidité
    if (dataset.data.length > 30) {
      dataset.data.shift();
    }
  }

  if (priceChart.data.labels.length > 30) {
    priceChart.data.labels.shift();
  }

  priceChart.update();
}

// === LOGIQUE DE PRIX ET ALGORITHME ===

function calculerPrixMystere() {
  // On isole les vraies bières pour calculer la moyenne
  const bieresStandard = Object.keys(parametresBieres).filter(b => b !== "biere_4_mystere");
  
  let total = 0;
  for (const biere of bieresStandard) {
    total += Number(prixCourants[biere]);
  }
  
  const moyenne = total / bieresStandard.length;
  
  // Le prix mystère est la moyenne moins le rabais. Il ne descend jamais sous 1.00€ par sécurité.
  prixCourants["biere_4_mystere"] = arrondirPrix(Math.max(1.00, moyenne - RABAIS_MYSTERE));
}

function calculerNouveauxPrix(biereVendue, quantite, estAnnulation = false) {
  if (isKrachActive) {
    for (const [biere, parametres] of Object.entries(parametresBieres)) {
      if (biere !== "biere_4_mystere") {
        prixCourants[biere] = Number(parametres.prix_min);
      }
    }
    calculerPrixMystere();
    return prixCourants;
  }

  const quantiteValide = Number(quantite);

  if (!Number.isInteger(quantiteValide) || quantiteValide < 1) {
    throw new Error(`Quantité invalide : ${quantite}`);
  }

  if (!parametresBieres[biereVendue]) {
    throw new Error(`Paramètres introuvables pour : ${biereVendue}`);
  }

  const signe = estAnnulation ? -1 : 1;
  const variation = signe * HAUSSE_PAR_UNITE * quantiteValide;

  // 1. Seule la bière vendue voit son prix augmenter
  const prixActuel = Number(prixCourants[biereVendue]);
  const params = parametresBieres[biereVendue];
  
  if (!Number.isFinite(prixActuel)) {
    throw new Error(`Prix actuel invalide pour : ${biereVendue}`);
  }

  prixCourants[biereVendue] = arrondirPrix(
    Math.min(
      Number(params.prix_max),
      Math.max(Number(params.prix_min), prixActuel + variation)
    )
  );

  // 2. On met à jour la bière mystère en fonction du nouveau marché
  calculerPrixMystere();
  
  return prixCourants;
}

function memoriserPrixAvantCalcul() {
  for (const [biere, prix] of Object.entries(prixCourants)) {
    prixAvantDernierEvenement[biere] = Number(prix);
  }
}

// === GESTION DE L'AFFICHAGE ===
function afficherPrixEtTendances() {
  for (const biere of Object.keys(parametresBieres)) {
    const prixElement = document.querySelector(`#prix-${biere}`);
    const tendanceElement = document.querySelector(`[data-trend-for="${biere}"]`);

    if (!prixElement || !tendanceElement) {
      continue;
    }

    const prix = Number(prixCourants[biere]);
    const ancienPrix = prixAvantDernierEvenement[biere];

    prixElement.textContent = `${prix.toFixed(2)} €`;

    if (ancienPrix === undefined || prix === ancienPrix) {
      continue;
    }

    const prixEnHausse = prix > ancienPrix;
    tendanceElement.textContent = prixEnHausse ? "▲" : "▼";
    tendanceElement.classList.toggle("trend-up", prixEnHausse);
    tendanceElement.classList.toggle("trend-down", !prixEnHausse);
    tendanceElement.setAttribute("aria-label", prixEnHausse ? "Hausse" : "Baisse");
  }
}

// === GESTION DU KRACH BOURSIER ===
function appliquerEtatKrach() {
  isKrachActive = true;
  document.body.classList.add("krach-active");

  // Toutes les vraies bières passent au prix minimum
  for (const [biere, parametres] of Object.entries(parametresBieres)) {
    if (biere !== "biere_4_mystere") {
      prixCourants[biere] = Number(parametres.prix_min);
    }
  }
  
  calculerPrixMystere();
  afficherPrixEtTendances();

  if (krachTimeoutId) {
    window.clearTimeout(krachTimeoutId);
  }

  krachTimeoutId = window.setTimeout(async () => {
    isKrachActive = false;
    document.body.classList.remove("krach-active");
    krachTimeoutId = null;

    try {
      await set(ref(db, "prix_actuels"), {
        ...prixCourants,
        etat: "normal"
      });
    } catch (error) {
      console.error("Erreur lors de la réinitialisation de l'état du Krach.", error);
    }
  }, 15000); // Durée du krach : 15 secondes
}

// === GESTION DES EVENEMENTS (VENTE / ANNULATION) ===
async function obtenirBiereEtQuantitePourAnnulation(evenement) {
  let venteOrigine = ventesTraitees.get(evenement.reference_annulation);

  if (!venteOrigine) {
    const venteSnapshot = await get(
      ref(db, `journal_ventes/${evenement.reference_annulation}`)
    );
    venteOrigine = venteSnapshot.val();
  }

  if (!venteOrigine ||
      !venteOrigine.biere ||
      !Number.isInteger(Number(venteOrigine.quantite))) {
    throw new Error(
      `Vente de référence introuvable : ${evenement.reference_annulation}`
    );
  }

  return {
    biere: venteOrigine.biere,
    quantite: Number(venteOrigine.quantite)
  };
}

async function traiterEvenement(snapshot) {
  const evenement = snapshot.val();

  if (!evenement || typeof evenement !== "object") {
    return false;
  }

  if (!Number.isFinite(Number(evenement.timestamp)) ||
      Number(evenement.timestamp) < startupTime) {
    return false;
  }

  if (evenement.action === "krach_boursier") {
    appliquerEtatKrach();
    await set(ref(db, "prix_actuels"), {
      ...prixCourants,
      etat: "krach"
    });
    updateChart(prixCourants);
    return true;
  } else if (evenement.action === "fin_krach") {
    isKrachActive = false;
    document.body.classList.remove("krach-active");
    if (krachTimeoutId) {
      window.clearTimeout(krachTimeoutId);
      krachTimeoutId = null;
    }
    await set(ref(db, "prix_actuels"), {
      ...prixCourants,
      etat: "normal"
    });
    return true;
  }

  if (evenement.action === "vente") {
    const quantite = Number(evenement.quantite);

    memoriserPrixAvantCalcul();
    calculerNouveauxPrix(evenement.biere, quantite);
    ventesTraitees.set(snapshot.key, {
      action: "vente",
      biere: evenement.biere,
      quantite
    });
  } else if (evenement.action === "annulation") {
    const venteAnnulee = await obtenirBiereEtQuantitePourAnnulation(evenement);

    memoriserPrixAvantCalcul();
    calculerNouveauxPrix(venteAnnulee.biere, venteAnnulee.quantite, true);
  } else {
    return false;
  }

  afficherPrixEtTendances();
  await set(ref(db, "prix_actuels"), {
    ...prixCourants,
    etat: isKrachActive ? "krach" : "normal"
  });
  updateChart(prixCourants);
  return true;
}

// === LA BOUCLE MAGIQUE : DEPRECIATION TEMPORELLE ===
setInterval(async () => {
  // On ne baisse pas les prix pendant un Krach (ils sont déjà au minimum)
  if (isKrachActive) {
    return;
  }

  let aChange = false;
  memoriserPrixAvantCalcul();

  const bieresStandard = Object.keys(parametresBieres).filter(b => b !== "biere_4_mystere");

  for (const biere of bieresStandard) {
    const prixActuel = Number(prixCourants[biere]);
    const prixMin = Number(parametresBieres[biere].prix_min);
    
    // Si la bière est plus chère que son prix minimum, elle baisse de 0.05€
    if (prixActuel > prixMin) {
      prixCourants[biere] = arrondirPrix(Math.max(prixMin, prixActuel - BAISSE_TEMPORELLE));
      aChange = true;
    }
  }

  // Si au moins une bière a baissé, on met à jour le Dashboard et Firebase
  if (aChange) {
    calculerPrixMystere();
    afficherPrixEtTendances();
    updateChart(prixCourants);
    
    try {
      await set(ref(db, "prix_actuels"), {
        ...prixCourants,
        etat: "normal"
      });
    } catch (error) {
      console.error("Erreur lors de la mise à jour temporelle des prix.", error);
    }
  }
}, INTERVALLE_TEMPS);

// === DEMARRAGE ET INITIALISATION ===
async function chargerEtatInitial() {
  const [parametresSnapshot, prixSnapshot] = await Promise.all([
    get(ref(db, "parametres_bieres")),
    get(ref(db, "prix_actuels"))
  ]);

  const parametres = parametresSnapshot.val();
  const prix = prixSnapshot.val();

  if (!parametres || typeof parametres !== "object") {
    throw new Error("Le nœud parametres_bieres est absent ou invalide.");
  }

  if (!prix || typeof prix !== "object") {
    throw new Error("Le nœud prix_actuels est absent ou invalide.");
  }

  Object.assign(parametresBieres, parametres);
  
  // Ajout virtuel de la bière mystère dans les paramètres pour la configuration
  parametresBieres["biere_4_mystere"] = {
    nom: "Pinte Mystère",
    prix_min: 1, // Sécurité absolue
    prix_max: 99
  };

  for (const biere of Object.keys(parametresBieres)) {
    // La bière mystère n'est pas dans Firebase au démarrage, on la saute ici
    if (biere !== "biere_4_mystere") {
      if (prix[biere] === undefined || prix[biere] === null) {
        throw new Error(`Prix initial absent pour : ${biere}`);
      }
      prixCourants[biere] = Number(prix[biere]);
    }
  }

  // Initialisation du prix mystère basé sur les vrais prix récupérés
  calculerPrixMystere();
  
  afficherPrixEtTendances();
  initChart(parametresBieres, prixCourants);

  // Force l'état normal au démarrage pour ne jamais ouvrir en Krach
  await set(ref(db, "prix_actuels/etat"), "normal");
}

async function demarrerMoteur() {
  // 1. Connexion automatique et silencieuse du Dashboard
  try {
    await signInWithEmailAndPassword(auth, "dashboard@foyer.com", "dashboard");
    console.log("Cerveau connecté avec succès !");
  } catch (error) {
    console.error("Le Dashboard n'a pas pu s'authentifier.", error);
    alert("Erreur de connexion du Dashboard. Vérifiez les identifiants.");
    return; // On arrête tout si le PC n'a pas les droits
  }

  // 2. Lancement de la machine
  await chargerEtatInitial();

  let traitementEnCours = Promise.resolve();

  // Écoute des nouvelles ventes
  onChildAdded(ref(db, "journal_ventes"), (snapshot) => {
    traitementEnCours = traitementEnCours
      .then(() => traiterEvenement(snapshot))
      .catch((error) => {
        console.error("Impossible de traiter l'événement de vente.", error);
      });
  });
}

demarrerMoteur().catch((error) => {
  console.error("Impossible de démarrer le moteur de la Bourse.", error);
});
