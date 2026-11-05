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

const startupTime = Date.now() - 120000;

// === PARAMÈTRES DE L'ALGORITHME ===
const HAUSSE_PAR_UNITE = 0.30;       
const BAISSE_TEMPORELLE = 0.05;      
const RABAIS_MYSTERE = 0.30;         
const INTERVALLE_TEMPS = 15000;      

const parametresBieres = {};
const prixCourants = {};
const ventesTraitees = new Map();
const prixAvantDernierEvenement = {};

const chartColors = {
  biere_1_blonde: "#FFD60A",
  biere_2_ipa: "#FF9F0A",
  biere_3_rouge: "#FF453A",
  biere_4_mystere: "#BF5AF2" 
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

  if (!canvas) throw new Error("Canvas #priceChart introuvable.");
  if (typeof Chart === "undefined") throw new Error("Chart.js n'est pas chargé.");

  canvas.style.backgroundColor = "transparent";
  const labelInitial = getCurrentTimeLabel();

  const datasets = Object.entries(parametres).map(([biere, configuration]) => ({
    label: configuration.nom || biere,
    biereId: biere,
    data: [Number(prixInitiaux[biere])],
    borderColor: chartColors[biere] || "#ffffff",
    backgroundColor: chartColors[biere] || "#ffffff",
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
          min: 0, // FORCÉ À 0
          max: 7, // FORCÉ À 7
          grid: { color: "#333333" },
          ticks: {
            color: "#d8d8d8",
            callback: (value) => `${Number(value).toFixed(2)} €`
          }
        }
      },
      plugins: {
        legend: { labels: { color: "#f2f4f3", font: { family: "Montserrat, Segoe UI, sans-serif", weight: "600" } } }
      }
    }
  });
}

function updateChart(nouveauxPrix) {
  if (!priceChart) return;

  priceChart.data.labels.push(getCurrentTimeLabel());

  for (const dataset of priceChart.data.datasets) {
    dataset.data.push(Number(nouveauxPrix[dataset.biereId]));
    if (dataset.data.length > 30) dataset.data.shift();
  }

  if (priceChart.data.labels.length > 30) priceChart.data.labels.shift();
  priceChart.update();
}

// === LOGIQUE DE PRIX ET ALGORITHME ===
function calculerPrixMystere() {
  const bieresStandard = Object.keys(parametresBieres).filter(b => b !== "biere_4_mystere");
  let total = 0;
  for (const biere of bieresStandard) total += Number(prixCourants[biere]);
  
  const moyenne = total / bieresStandard.length;
  prixCourants["biere_4_mystere"] = arrondirPrix(Math.max(1.00, moyenne - RABAIS_MYSTERE));
}

function calculerNouveauxPrix(biereVendue, quantite, estAnnulation = false) {
  if (isKrachActive) {
    for (const [biere, parametres] of Object.entries(parametresBieres)) {
      if (biere !== "biere_4_mystere") prixCourants[biere] = Number(parametres.prix_min);
    }
    calculerPrixMystere();
    return prixCourants;
  }

  const quantiteValide = Number(quantite);
  const signe = estAnnulation ? -1 : 1;
  const variation = signe * HAUSSE_PAR_UNITE * quantiteValide;

  const prixActuel = Number(prixCourants[biereVendue]);
  const params = parametresBieres[biereVendue];
  
  prixCourants[biereVendue] = arrondirPrix(
    Math.min(Number(params.prix_max), Math.max(Number(params.prix_min), prixActuel + variation))
  );

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

    if (!prixElement || !tendanceElement) continue;

    const prix = Number(prixCourants[biere]);
    const ancienPrix = prixAvantDernierEvenement[biere];

    prixElement.textContent = `${prix.toFixed(2)} €`;

    if (ancienPrix === undefined || prix === ancienPrix) continue;

    const prixEnHausse = prix > ancienPrix;
    
    // Animation du Flash (Force le redessin en supprimant/remettant la classe)
    prixElement.classList.remove("flash-up", "flash-down");
    void prixElement.offsetWidth; // Déclenche le reflow
    prixElement.classList.add(prixEnHausse ? "flash-up" : "flash-down");

    // Mise à jour de la flèche
    tendanceElement.textContent = prixEnHausse ? "▲" : "▼";
    tendanceElement.classList.toggle("trend-up", prixEnHausse);
    tendanceElement.classList.toggle("trend-down", !prixEnHausse);
  }
}

// === GESTION DES BARRES DE PROGRESSION ===
function restartTimers() {
  document.querySelectorAll('.timer-fill').forEach(fill => {
    fill.style.animation = 'none';
    void fill.offsetWidth; // Force reflow
    // Lance l'animation de 15 secondes qui va de 100% à 0%
    fill.style.animation = `countdown ${INTERVALLE_TEMPS / 1000}s linear forwards`;
  });
}

function stopTimers() {
  document.querySelectorAll('.timer-fill').forEach(fill => {
    fill.style.animation = 'none';
    fill.style.transform = 'scaleX(0)'; // Vide la barre
  });
}

// Configuration de l'animation CSS en JS (pour éviter de la coder en dur en CSS)
const styleSheet = document.createElement("style");
styleSheet.innerText = `
  @keyframes countdown {
    0% { transform: scaleX(1); background: var(--color-up); }
    50% { background: var(--color-mystere); }
    100% { transform: scaleX(0); background: var(--color-down); }
  }
`;
document.head.appendChild(styleSheet);


// === GESTION DU KRACH BOURSIER ===
function appliquerEtatKrach() {
  isKrachActive = true;
  document.body.classList.add("krach-active");
  stopTimers(); // Gèle le compte à rebours

  for (const [biere, parametres] of Object.entries(parametresBieres)) {
    if (biere !== "biere_4_mystere") prixCourants[biere] = Number(parametres.prix_min);
  }
  
  calculerPrixMystere();
  afficherPrixEtTendances();

  if (krachTimeoutId) window.clearTimeout(krachTimeoutId);

  krachTimeoutId = window.setTimeout(async () => {
    isKrachActive = false;
    document.body.classList.remove("krach-active");
    krachTimeoutId = null;
    restartTimers(); // Reprend le compte à rebours

    try {
      await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "normal" });
    } catch (error) {
      console.error("Erreur réinitialisation Krach", error);
    }
  }, 15000); 
}

// === GESTION DES EVENEMENTS (VENTE / ANNULATION) ===
async function obtenirBiereEtQuantitePourAnnulation(evenement) {
  let venteOrigine = ventesTraitees.get(evenement.reference_annulation);
  if (!venteOrigine) {
    const snapshot = await get(ref(db, `journal_ventes/${evenement.reference_annulation}`));
    venteOrigine = snapshot.val();
  }
  return { biere: venteOrigine.biere, quantite: Number(venteOrigine.quantite) };
}

async function traiterEvenement(snapshot) {
  const evenement = snapshot.val();
  if (!evenement || typeof evenement !== "object" || Number(evenement.timestamp) < startupTime) return false;

  if (evenement.action === "krach_boursier") {
    appliquerEtatKrach();
    await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "krach" });
    updateChart(prixCourants);
    return true;
  } else if (evenement.action === "fin_krach") {
    isKrachActive = false;
    document.body.classList.remove("krach-active");
    if (krachTimeoutId) { window.clearTimeout(krachTimeoutId); krachTimeoutId = null; }
    restartTimers();
    await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "normal" });
    return true;
  }

  if (evenement.action === "vente") {
    memoriserPrixAvantCalcul();
    calculerNouveauxPrix(evenement.biere, Number(evenement.quantite));
    ventesTraitees.set(snapshot.key, { action: "vente", biere: evenement.biere, quantite: Number(evenement.quantite) });
  } else if (evenement.action === "annulation") {
    const venteAnnulee = await obtenirBiereEtQuantitePourAnnulation(evenement);
    memoriserPrixAvantCalcul();
    calculerNouveauxPrix(venteAnnulee.biere, venteAnnulee.quantite, true);
  } else {
    return false;
  }

  afficherPrixEtTendances();
  await set(ref(db, "prix_actuels"), { ...prixCourants, etat: isKrachActive ? "krach" : "normal" });
  updateChart(prixCourants);
  return true;
}

// === LA BOUCLE MAGIQUE : DEPRECIATION TEMPORELLE ===
setInterval(async () => {
  if (isKrachActive) return;

  let aChange = false;
  memoriserPrixAvantCalcul();

  const bieresStandard = Object.keys(parametresBieres).filter(b => b !== "biere_4_mystere");

  for (const biere of bieresStandard) {
    const prixActuel = Number(prixCourants[biere]);
    const prixMin = Number(parametresBieres[biere].prix_min);
    
    if (prixActuel > prixMin) {
      prixCourants[biere] = arrondirPrix(Math.max(prixMin, prixActuel - BAISSE_TEMPORELLE));
      aChange = true;
    }
  }

  restartTimers(); // Relance la barre de progression quoi qu'il arrive

  if (aChange) {
    calculerPrixMystere();
    afficherPrixEtTendances(); // Va déclencher les animations de Flash
    updateChart(prixCourants);
    
    try {
      await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "normal" });
    } catch (e) {
      console.error("Erreur temporelle", e);
    }
  }
}, INTERVALLE_TEMPS);

// === DEMARRAGE ET INITIALISATION ===
async function chargerEtatInitial() {
  const [parametresSnapshot, prixSnapshot] = await Promise.all([
    get(ref(db, "parametres_bieres")),
    get(ref(db, "prix_actuels"))
  ]);

  Object.assign(parametresBieres, parametresSnapshot.val());
  
  // Correction de la limite pour le graphique : prix_max à 7
  parametresBieres["biere_4_mystere"] = { nom: "Pinte Mystère", prix_min: 1, prix_max: 7 };

  const prix = prixSnapshot.val();
  for (const biere of Object.keys(parametresBieres)) {
    if (biere !== "biere_4_mystere") {
      prixCourants[biere] = Number(prix[biere]);
    }
  }

  calculerPrixMystere();
  afficherPrixEtTendances();
  initChart(parametresBieres, prixCourants);
  restartTimers(); // Démarre les barres au chargement de la page

  await set(ref(db, "prix_actuels/etat"), "normal");
}

async function demarrerMoteur() {
  try {
    await signInWithEmailAndPassword(auth, "dashboard@foyer.com", "dashboard");
    console.log("Cerveau connecté avec succès !");
  } catch (error) {
    console.error("Erreur Auth", error);
    alert("Erreur de connexion du Dashboard.");
    return; 
  }

  await chargerEtatInitial();

  let traitementEnCours = Promise.resolve();

  onChildAdded(ref(db, "journal_ventes"), (snapshot) => {
    traitementEnCours = traitementEnCours
      .then(() => traiterEvenement(snapshot))
      .catch((error) => console.error("Erreur événement", error));
  });
}

demarrerMoteur().catch(console.error);
