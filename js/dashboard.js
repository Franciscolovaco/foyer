import { db, auth } from "../firebase-config.js";
import {
  get, onChildAdded, ref, set
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

let priceChart = null;
let isKrachActive = false;
let krachTimeoutId = null;

const startupTime = Date.now() - 120000;

const HAUSSE_PAR_UNITE = 0.30;       
const BAISSE_TEMPORELLE = 0.05;      
const RABAIS_MYSTERE = 0.30;         
const INTERVALLE_TEMPS = 15000;      

const parametresBieres = {};
const prixCourants = {};
const ventesTraitees = new Map();
const prixAvantDernierEvenement = {};

// GESTION INDIVIDUELLE DES TIMERS
const timersBieres = {
  biere_1_blonde: null,
  biere_2_ipa: null,
  biere_3_rouge: null
};

const chartColors = {
  biere_1_blonde: "#FFD60A",
  biere_2_ipa: "#FF9F0A",
  biere_3_rouge: "#FF453A",
  biere_4_mystere: "#BF5AF2" 
};

// Injection de l'animation de barre de progression
const styleSheet = document.createElement("style");
styleSheet.innerText = `
  @keyframes countdown {
    0% { transform: scaleX(1); background: var(--color-up); }
    50% { background: var(--color-mystere); }
    100% { transform: scaleX(0); background: var(--color-down); }
  }
`;
document.head.appendChild(styleSheet);

function getCurrentTimeLabel() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function arrondirPrix(prix) {
  return Math.round((prix + Number.EPSILON) * 100) / 100;
}

function initChart(parametres, prixInitiaux) {
  const canvas = document.querySelector("#priceChart");
  if (!canvas) throw new Error("Canvas introuvable.");

  const datasets = Object.entries(parametres).map(([biere, configuration]) => ({
    label: configuration.nom || biere,
    biereId: biere,
    data: [Number(prixInitiaux[biere])],
    borderColor: chartColors[biere] || "#ffffff",
    borderWidth: biere === "biere_4_mystere" ? 2 : 4,
    borderDash: biere === "biere_4_mystere" ? [5, 5] : [],
    pointRadius: 3, tension: 0, fill: false
  }));

  priceChart = new Chart(canvas, {
    type: "line",
    data: { labels: [getCurrentTimeLabel()], datasets },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      scales: { x: { grid: { color: "#333333" } }, y: { min: 0, max: 7, grid: { color: "#333333" } } },
      plugins: { legend: { labels: { color: "#f2f4f3" } } }
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

function memoriserPrixAvantCalcul() {
  for (const [biere, prix] of Object.entries(prixCourants)) {
    prixAvantDernierEvenement[biere] = Number(prix);
  }
}

// === GESTION DES ANIMATIONS FLOTTANTES ===
function afficherAnimationVariation(biere, variation, enHausse) {
  const floatElement = document.querySelector(`[data-float-for="${biere}"]`);
  if (!floatElement) return;

  const sign = enHausse ? "+" : "-";
  floatElement.textContent = `${sign}${Math.abs(variation).toFixed(2)}`;
  
  floatElement.classList.remove("float-active-up", "float-active-down");
  void floatElement.offsetWidth; // Reflow
  floatElement.classList.add(enHausse ? "float-active-up" : "float-active-down");
}

function afficherPrixEtTendances() {
  for (const biere of Object.keys(parametresBieres)) {
    const prixElement = document.querySelector(`#prix-${biere}`);
    const tendanceElement = document.querySelector(`[data-trend-for="${biere}"]`);
    const trendValElement = document.querySelector(`[data-trendval-for="${biere}"]`);

    if (!prixElement || !tendanceElement) continue;

    const prix = Number(prixCourants[biere]);
    const ancienPrix = prixAvantDernierEvenement[biere];

    prixElement.textContent = `${prix.toFixed(2)} €`;

    if (ancienPrix === undefined || prix === ancienPrix) continue;

    const variation = prix - ancienPrix;
    const prixEnHausse = prix > ancienPrix;
    
    // Animation Flash sur le texte principal
    prixElement.classList.remove("flash-up", "flash-down");
    void prixElement.offsetWidth;
    prixElement.classList.add(prixEnHausse ? "flash-up" : "flash-down");

    // Affichage des tendances
    tendanceElement.textContent = prixEnHausse ? "▲" : "▼";
    tendanceElement.className = `trend ${prixEnHausse ? "trend-up" : "trend-down"}`;
    if(trendValElement) trendValElement.textContent = `${prixEnHausse ? "+" : ""}${variation.toFixed(2)}€`;
    
    // Déclenchement de l'animation flottante RPG
    afficherAnimationVariation(biere, variation, prixEnHausse);
  }
}

// === LOGIQUE DE PRIX ===
function calculerPrixMystere() {
  const bieresStandard = Object.keys(parametresBieres).filter(b => b !== "biere_4_mystere");
  let total = 0;
  for (const biere of bieresStandard) total += Number(prixCourants[biere]);
  const moyenne = total / bieresStandard.length;
  prixCourants["biere_4_mystere"] = arrondirPrix(Math.max(1.00, moyenne - RABAIS_MYSTERE));
}

function calculerNouveauxPrix(biereVendue, quantite, estAnnulation = false) {
  if (isKrachActive) return;

  const quantiteValide = Number(quantite);
  const signe = estAnnulation ? -1 : 1;
  const variation = signe * HAUSSE_PAR_UNITE * quantiteValide;

  const prixActuel = Number(prixCourants[biereVendue]);
  const params = parametresBieres[biereVendue];
  
  prixCourants[biereVendue] = arrondirPrix(
    Math.min(Number(params.prix_max), Math.max(Number(params.prix_min), prixActuel + variation))
  );

  calculerPrixMystere();
}

// === GESTION INDIVIDUELLE DES TIMERS ===
function resetBarreVisuelle(biereId) {
  const container = document.querySelector(`[data-timer-for="${biereId}"]`);
  if (!container) return;
  const fill = container.querySelector('.timer-fill');
  if (fill) {
    fill.style.animation = 'none';
    void fill.offsetWidth; // Force le redessin
    fill.style.animation = `countdown ${INTERVALLE_TEMPS / 1000}s linear forwards`;
  }
}

function startTimerForBiere(biereId) {
  if (biereId === "biere_4_mystere") return;
  if (timersBieres[biereId]) clearInterval(timersBieres[biereId]);

  resetBarreVisuelle(biereId);

  timersBieres[biereId] = setInterval(async () => {
    if (isKrachActive) return;

    const prixActuel = Number(prixCourants[biereId]);
    const prixMin = Number(parametresBieres[biereId].prix_min);
    
    // On redémarre la barre même si le prix est au min (pour l'effet d'attente)
    resetBarreVisuelle(biereId); 

    if (prixActuel > prixMin) {
      memoriserPrixAvantCalcul();
      prixCourants[biereId] = arrondirPrix(Math.max(prixMin, prixActuel - BAISSE_TEMPORELLE));
      calculerPrixMystere();
      
      afficherPrixEtTendances();
      updateChart(prixCourants);
      await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "normal" });
    }
  }, INTERVALLE_TEMPS);
}

function stopAllTimers() {
  for (const biere of Object.keys(timersBieres)) {
    if (timersBieres[biere]) clearInterval(timersBieres[biere]);
    const container = document.querySelector(`[data-timer-for="${biere}"]`);
    if (container) {
       const fill = container.querySelector('.timer-fill');
       if(fill) {
         fill.style.animation = 'none';
         fill.style.transform = 'scaleX(0)'; 
       }
    }
  }
}

function startAllTimers() {
  for (const biere of Object.keys(parametresBieres)) {
    startTimerForBiere(biere);
  }
}

// === EVENEMENTS & KRACH ===
function appliquerEtatKrach() {
  isKrachActive = true;
  document.body.classList.add("krach-active");
  stopAllTimers(); 

  memoriserPrixAvantCalcul();
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
    startAllTimers();
    await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "normal" });
  }, 15000); 
}

async function traiterEvenement(snapshot) {
  const evenement = snapshot.val();
  if (!evenement || Number(evenement.timestamp) < startupTime) return false;

  if (evenement.action === "krach_boursier") {
    appliquerEtatKrach();
    await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "krach" });
    updateChart(prixCourants);
    return true;
  } else if (evenement.action === "fin_krach") {
    isKrachActive = false;
    document.body.classList.remove("krach-active");
    if (krachTimeoutId) { window.clearTimeout(krachTimeoutId); krachTimeoutId = null; }
    startAllTimers();
    await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "normal" });
    return true;
  }

  if (evenement.action === "vente" || evenement.action === "annulation") {
    memoriserPrixAvantCalcul();
    
    if(evenement.action === "vente") {
      calculerNouveauxPrix(evenement.biere, evenement.quantite);
      ventesTraitees.set(snapshot.key, evenement);
    } else {
      let venteRef = ventesTraitees.get(evenement.reference_annulation);
      if(!venteRef) {
         const snap = await get(ref(db, `journal_ventes/${evenement.reference_annulation}`));
         venteRef = snap.val();
      }
      calculerNouveauxPrix(venteRef.biere, venteRef.quantite, true);
    }

    // Le reset individuel !
    if (evenement.biere !== "biere_4_mystere") {
      startTimerForBiere(evenement.biere);
    }

    afficherPrixEtTendances();
    await set(ref(db, "prix_actuels"), { ...prixCourants, etat: "normal" });
    updateChart(prixCourants);
  }
}

// === LANCEMENT ===
async function chargerEtatInitial() {
  const [parametresSnapshot, prixSnapshot] = await Promise.all([
    get(ref(db, "parametres_bieres")),
    get(ref(db, "prix_actuels"))
  ]);

  Object.assign(parametresBieres, parametresSnapshot.val());
  parametresBieres["biere_4_mystere"] = { nom: "Pinte Mystère", prix_min: 1, prix_max: 7 };

  const prix = prixSnapshot.val();
  for (const biere of Object.keys(parametresBieres)) {
    if (biere !== "biere_4_mystere") prixCourants[biere] = Number(prix[biere]);
  }

  calculerPrixMystere();
  afficherPrixEtTendances();
  initChart(parametresBieres, prixCourants);
  startAllTimers();

  await set(ref(db, "prix_actuels/etat"), "normal");
}

async function demarrerMoteur() {
  try {
    await signInWithEmailAndPassword(auth, "dashboard@foyer.com", "dashboard");
  } catch (error) {
    alert("Erreur de connexion du Dashboard."); return; 
  }
  await chargerEtatInitial();
  let traitementEnCours = Promise.resolve();
  onChildAdded(ref(db, "journal_ventes"), (snapshot) => {
    traitementEnCours = traitementEnCours.then(() => traiterEvenement(snapshot)).catch(console.error);
  });
}

demarrerMoteur().catch(console.error);
