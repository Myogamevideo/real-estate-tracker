# Maison & Marché

Dashboard local de suivi immobilier autour d'une adresse française.

Version publique : [myogamevideo.github.io/real-estate-tracker](https://myogamevideo.github.io/real-estate-tracker/).

## Démarrer

Le projet n'a pas de dépendance à installer. Pour activer les ventes détaillées, lancez le serveur local (Python 3 requis) :

```sh
python3 server.py
```

Puis ouvrez `http://127.0.0.1:8000`.
Si le port 8000 est déjà utilisé, choisissez-en un autre :

```sh
PORT=4173 python3 server.py
```

Ouvrez alors `http://127.0.0.1:4173`.

La localisation initiale est lue depuis `config.local.js`, un fichier ignoré par Git. Il ne contient que des coordonnées et le nom de la commune. Pour une autre adresse, utilisez le bouton de réglage dans l'application : l'adresse est transmise à la Base Adresse Nationale (BAN), et seules les coordonnées et le nom de la commune sont conservés dans le stockage local du navigateur.

## Données et limites

- Les ventes conclues proviennent de l'API DVF publiée par data.gouv.fr. Elles sont mises à jour selon le calendrier de la DGFiP ; ce ne sont pas des annonces en cours.
- Le rayon de 20 km est calculé à partir du centre géographique de chaque commune. Les prix affichés sont des estimations agrégées à partir des prix communaux DVF, pondérées par le nombre de ventes sur la période disponible ; la courbe mensuelle porte sur la commune de l'adresse. Ce n'est pas une expertise immobilière ni un calcul parcellaire exact.
- Le profil (DPE, surfaces, pièces et année de construction) est une référence personnelle. Le repère DVF général multiplie la surface habitable par le prix local moyen DVF des maisons. Un repère complémentaire utilise le prix au m² des ventes détaillées filtrées selon les critères actifs ; il présente la médiane et l'intervalle interquartile d'une extrapolation à la surface du logement. Ce n'est pas une expertise et les caractéristiques non comparées (état, garage, emplacement précis) ne sont pas ajustées.
- Les ventes comparables peuvent être filtrées par surface, pièces, terrain, DPE et année de construction. Par défaut, le filtre de construction couvre ±10 ans autour de l'année du profil ; pour une maison construite en 1973, la plage est 1963–1983. L'année des bâtiments comparables provient de la BDNB et les années inconnues ne correspondent pas au filtre. Le tableau peut aussi être filtré par année de vente et trié par date, prix, surface ou terrain ; les exports CSV/JSON reprennent les lignes visibles. L'évolution annuelle et l'historique hebdomadaire présentent les prix et volumes de l'échantillon retenu.
- La comparaison avec le prix d'achat indique l'écart par rapport à la médiane et à la fourchette extrapolées des comparables. C'est une indication brute, pas une plus-value nette ou réalisée : frais d'acquisition, travaux et caractéristiques précises du bien ne sont pas pris en compte.
- Les comparables détaillés sont téléchargés à la demande depuis les partitions départementales DVF géolocalisées publiées sur data.gouv.fr. Les années courantes sont prises en compte dès qu'une partition départementale est publiée ; les partitions absentes de l'année courante sont ignorées et la période réellement utilisée est affichée. Les archives consultées sont gardées dans un cache mémoire borné pendant l'exécution du serveur, afin d'éviter de les retélécharger à chaque changement de filtre. Les ventes sont filtrées localement par type de maison, rayon, surface bâtie, pièces et terrain. Le serveur ne sauvegarde pas les fichiers DVF ni les ventes ; les résultats détaillés exposent désormais au navigateur les identifiants cadastraux et coordonnées DVF des comparables, sans adresse. Les ventes multi-biens ou ambiguës sont exclues et les résultats détaillés sont masqués sous cinq transactions comparables. L'onglet « Transactions comparables » montre les points géolocalisés, les références cadastrales et un lien vers l'explorateur DVF officiel. Les points ne représentent pas les limites de la parcelle ; la position est celle publiée dans DVF.
- Les filtres DPE et année de construction utilisent l'export départemental BDNB du CSTB (`2026-02-b` par défaut), téléchargé à la demande. Le serveur lit les tables DPE, relations bâtiment–DPE / bâtiment–parcelle et l'année de construction des bâtiments, puis indexe les résultats localement dans `.cache/bdnb-dpe.sqlite3`. Le cache est réutilisé après redémarrage et réindexé après 90 jours ; réglez `BDNB_CACHE_TTL_DAYS` pour modifier cette durée, `0` pour forcer une réindexation ou `BDNB_VERSION` pour choisir un autre millésime. Jusqu'à 10 000 parcelles candidates proches des critères sont vérifiées par requête ; les nombres vérifié et total sont affichés. Les données BDNB peuvent manquer ou être ambiguës et ne décrivent pas nécessairement le logement vendu à la date de mutation.
- Pour Cournon-d'Auvergne, le calcul inclut les communes du Puy-de-Dôme et des départements limitrophes. Les annonces en ligne ne disposant pas d'un flux public gratuit et autorisé, elles sont ajoutées manuellement : aucun portail n'est scrappé.
- Les annonces suivies et la localisation restent dans le stockage du navigateur. Les annonces ont un statut manuel, une date de mise à jour et un historique des changements de prix saisis lors d'une modification. Les baisses de prix et correspondances de critères sont signalées à partir des informations que vous saisissez ; les détails facultatifs (pièces, terrain, année, DPE) améliorent la correspondance. Les annonces ne sont jamais collectées automatiquement. Le menu « Sauvegarder profil et annonces » exporte un fichier JSON (localisation, profil et annonces), que l'on peut restaurer dans le même navigateur ; la restauration remplace les données locales correspondantes. Conservez vous-même une copie de la sauvegarde. La carte des comparables applique le filtre d'année de vente et un rayon réglable ; sa légende distingue le centre de la commune des ventes, dont les fiches s'ouvrent au clic.
- Un mode GitHub Pages statique publie un instantané des comparables chaque semaine via GitHub Actions (`.github/workflows/deploy-pages.yml`). Configurez les secrets `HOME_LATITUDE` et `HOME_LONGITUDE`, ainsi que les variables `HOME_CITY_CODE`, `HOME_DEPARTMENT_CODE` et `HOME_DEPARTMENTS`. Les critères peuvent être réglés avec `COMPARABLE_MIN_AREA`, `COMPARABLE_MAX_AREA`, `COMPARABLE_MIN_ROOMS`, `COMPARABLE_MAX_ROOMS`, `COMPARABLE_MIN_LAND`, `COMPARABLE_MAX_LAND`, `COMPARABLE_MIN_CONSTRUCTION_YEAR`, `COMPARABLE_MAX_CONSTRUCTION_YEAR` et `COMPARABLE_DPE` ; ils sont fixes pour chaque instantané publié. Le site Pages et `data/comparables.json` sont publics : les identifiants cadastraux, coordonnées DVF et années BDNB des ventes y sont publiés. Le point exact de la maison reste dans les secrets ; la carte publique utilise le centre de la commune. Le workflow conserve `data/snapshot-history.json` (indicateurs agrégés sans coordonnées ni parcelles) dans le dépôt afin de tracer l'évolution, ce qui requiert l'autorisation `contents: write` du workflow. Le profil personnel, les annonces suivies et les sauvegardes ne sont pas publiés. Dans Settings > Pages, choisissez GitHub Actions comme source. Sans ces réglages, utilisez le mode local avec `python3 server.py`.

Pour forcer l'utilisation d'un nouveau millésime ou ajuster la durée du cache BDNB :

```sh
BDNB_VERSION=2026-02-b BDNB_CACHE_TTL_DAYS=90 python3 server.py
```
