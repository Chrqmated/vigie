# Vigie

Web-app (PWA) de navigation façon Waze, épurée : carte GPS en direct, vitesse, kilomètres, **radars de la base officielle du Ministère de l'Intérieur** avec leur vitesse maximale, alertes sonores et vocales (« Radar fixe à 500 mètres, limité à 90 »), radars tronçon avec vitesse moyenne, et signalement de radars manquants.

Aucun serveur, aucun compte : tout tourne dans Safari et reste sur votre iPhone.

## Installer sur iPhone

1. Ouvrir l'URL de l'app dans **Safari**.
2. **Partager → Sur l'écran d'accueil** (plein écran, icône Vigie).
3. Lancer Vigie, appuyer sur **Démarrer**, autoriser la position et la boussole.

Conseils : gardez l'app au premier plan, écran allumé (elle s'en charge). Le bouton latéral « silencieux » coupe les sons : désactivez-le, ou activez « Son même en mode silencieux » dans les réglages.

## Fonctionnalités

- Carte vectorielle (OpenFreeMap / OpenStreetMap), cap vers le haut, zoom automatique selon la vitesse, thème jour / nuit.
- Vitesse en grand, panneau de limitation (radar en approche, sinon limite OpenStreetMap), passage en orange puis rouge en cas d'excès.
- Kilomètres du trajet, durée, moyenne, maximum, odomètre total, historique des trajets.
- 3 309 radars fixes (tourelles, discriminants, urbains, tronçons, feux rouges, passages à niveau) avec route, sens et commune.
- Alertes anticipées selon la vitesse (25 s avant, bornées 300 m – 1,5 km), carillon, voix française, double bip à 300 m, « Ralentissez » en cas d'excès.
- Radars tronçon : annonce de la longueur, **vitesse moyenne en direct**, fin de tronçon.
- Signalement : radar mobile (expire automatiquement), fixe absent, feu rouge, danger ; appui long sur la carte pour placer ; export / import JSON.
- **Itinéraire façon Waze** : recherche d'adresse ou de lieu (Photon + Base Adresse Nationale), jusqu'à 3 propositions (le plus rapide, alternative, moins de radars) avec durée, heure d'arrivée, **coût du péage** (estimation ≈ 0,11 €/km d'autoroute, réglable) et **coût du carburant** (prix moyen national en direct, SP98 par défaut, consommation réglable), nombre de radars sur le trajet. Options « Éviter les péages » et « Éviter les radars » (recalcul en excluant les radars du trajet). Guidage visuel des manœuvres (vocal en option), bandeau arrivée / durée / km / coût, recalcul automatique hors route. Avec un itinéraire actif, **seuls les radars situés sur le trajet** déclenchent une alerte, avec la distance réelle par la route. Calcul par Valhalla (secours OSRM).
- Mise à jour de la base radars depuis data.gouv.fr directement dans l'app.
- Mode simulation pour tester voix et alertes sans rouler.
- Fonctionne hors connexion (hors tuiles non encore vues).

## Développement

```bash
npm run data     # régénère data/radars.json depuis data.gouv.fr
npm run icons    # régénère les icônes PNG
npm test         # tests géométrie + moteur d'alertes + itinéraire (réseau requis)
npm run serve    # serveur local http://localhost:8080
```

Vanilla HTML / CSS / JS (modules ES), MapLibre GL JS embarqué dans `vendor/`. Aucune étape de build.

## Données

- [Liste des radars fixes en France](https://www.data.gouv.fr/datasets/liste-des-radars-fixes-en-france) — Ministère de l'Intérieur, Licence Ouverte 2.0 (position, type, VMA).
- [Radars automatiques](https://www.data.gouv.fr/datasets/radars-automatiques) (2018) — route, sens, commune, longueur des tronçons, fusionnés par proximité.
- Limites de vitesse : OpenStreetMap via Overpass (couverture partielle).
- Cartes : © [OpenFreeMap](https://openfreemap.org) © [OpenMapTiles](https://openmaptiles.org) © [OpenStreetMap](https://www.openstreetmap.org/copyright).

## Limites connues

- iOS n'exécute pas les web-apps en arrière-plan : pas d'alerte écran éteint ou app masquée.
- L'État ne publie pas le sens de contrôle exploitable automatiquement : un radar qui flashe le sens opposé peut vous alerter (y compris sur itinéraire, les deux chaussées d'une autoroute étant à moins de 35 m).
- Le calcul d'itinéraire utilise les serveurs publics Valhalla / OSRM (gratuits, sans garantie de disponibilité). Les coûts de péage sont une estimation au kilomètre, pas le tarif exact de chaque concession.
- Les radars mobiles et voitures-radars ne figurent dans aucune base publique.
- Restez attentif à la route ; cette app est une aide, pas un dispositif homologué.
