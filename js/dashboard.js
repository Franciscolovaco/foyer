import { db } from "../firebase-config.js";
import {
  get,
  onChildAdded,
  onValue,
  ref,
  set
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-database.js";

let priceChart = null;
let isKrachActive = false;
let krachTimeoutId = null;

const startupTime = Date.now() - 120000;
const HAUSSE_PAR_UNITE = 0.20;
const BAISSE_AUTRES_PAR_UNITE = 0.05;

const parametresBieres = {};
const prixCourants = {};
const ventesTraitees = new Map();
const prixAvantDernierEvenement = {};

const chartColors = {
  biere_1_blonde: "#f5d547",
  biere_2_ipa: "#ff9f43",
  biere_3_rouge: "#ff4d5a"
};

function getCurrentTimeLabel() {
  return new Date().toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function initChart(parametres, prixInitiaux) {
  const canvas = document.querySelector("#priceChart");

  if (!canvas) {
    throw new Error("Canvas #priceChart introuvable.");
  }

  if (typeof Chart === "undefined") {
    throw new Error("Chart.js n'est pas chargé.");
  }

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
  const datasets = Object.entries(parametres).map(([biere, configuration]) => ({
    label: configuration.nom || biere,
    biereId: biere,
    data: [Number(prixInitiaux[biere])],
    borderColor: chartColors[biere] || "#ffffff",
    backgroundColor: chartColors[biere] || "#ffffff",
    borderWidth: 4,
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
          grid: {
            color: "#333333"
          },
          ticks: {
            color: "#d8d8d8",
            maxTicksLimit: 10
          }
        },
        y: {
          min: limitesPrix.min,
          max: limitesPrix.max,
          grid: {
            color: "#333333"
          },
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

    if (dataset.data.length > 30) {
      dataset.data.shift();
    }
  }

  if (priceChart.data.labels.length > 30) {
    priceChart.data.labels.shift();
  }

  priceChart.update();
}

function arrondirPrix(prix) {
  return Math.round((prix + Number.EPSILON) * 100) / 100;
}

function calculerNouveauxPrix(biereVendue, quantite, estAnnulation = false) {
  if (isKrachActive) {
    for (const [biere, parametres] of Object.entries(parametresBieres)) {
      prixCourants[biere] = Number(parametres.prix_min);
    }

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

  for (const [biere, parametres] of Object.entries(parametresBieres)) {
    const prixActuel = Number(prixCourants[biere]);

    if (!Number.isFinite(prixActuel)) {
      throw new Error(`Prix actuel invalide pour : ${biere}`);
    }

    const variation = biere === biereVendue
      ? signe * HAUSSE_PAR_UNITE * quantiteValide
      : -signe * BAISSE_AUTRES_PAR_UNITE * quantiteValide;

    prixCourants[biere] = arrondirPrix(
      Math.min(
        Number(parametres.prix_max),
        Math.max(Number(parametres.prix_min), prixActuel + variation)
      )
    );
  }

  return prixCourants;
}

function afficherPrixEtTendances() {
  for (const biere of Object.keys(parametresBieres)) {
    const prixElement = document.querySelector(`#prix-${biere}`);
    const tendanceElement = document.querySelector(`[data-trend-for="${biere}"]`);

    if (!prixElement || !tendanceElement) {
      console.error(`Éléments d'affichage introuvables pour : ${biere}`);
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

function appliquerEtatKrach() {
  isKrachActive = true;
  document.body.classList.add("krach-active");

  for (const [biere, parametres] of Object.entries(parametresBieres)) {
    prixCourants[biere] = Number(parametres.prix_min);
  }

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
  }, 15000);
}

function memoriserPrixAvantCalcul() {
  for (const [biere, prix] of Object.entries(prixCourants)) {
    prixAvantDernierEvenement[biere] = Number(prix);
  }
}

async function obtenirBiereEtQuantitePourAnnulation(evenement) {
  let venteOrigine = ventesTraitees.get(evenement.reference_annulation);

  if (!venteOrigine) {
    const venteSnapshot = await get(
      ref(db, `journal_ventes/${evenement.reference_annulation}`)
    );
    venteOrigine = venteSnapshot.val();
  }

  if (!venteOrigine ||
      venteOrigine.action !== "vente" ||
      !venteOrigine.biere ||
      !Number.isInteger(Number(venteOrigine.quantite))) {
    throw new Error(
      `Vente de référence introuvable : ${evenement.reference_annulation}`
    );
  }

  return {
    biere: venteOrigine.biere,
    quantite: venteOrigine.quantite
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
  }
  else if (evenement.action === "fin_krach") {
    isKrachActive = false;
    document.body.classList.remove("krach-active");
    if (krachTimeoutId) {
      window.clearTimeout(krachTimeoutId);
      krachTimeoutId = null;
    }
    // On met à jour l'état sur Firebase
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
  for (const biere of Object.keys(parametresBieres)) {
    if (prix[biere] === undefined || prix[biere] === null) {
      throw new Error(`Prix initial absent pour : ${biere}`);
    }

    prixCourants[biere] = Number(prix[biere]);
  }

  afficherPrixEtTendances();
  initChart(parametresBieres, prixCourants);

  if (prix.etat === "krach") {
    appliquerEtatKrach();
  }
}

async function demarrerMoteur() {
  await chargerEtatInitial();

  let traitementEnCours = Promise.resolve();

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
