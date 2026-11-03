# Maison & Marché

Dashboard local de suivi immobilier autour d'une adresse française.

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
- Le profil (DPE, surfaces, pièces) est une référence personnelle. Le repère DVF général multiplie la surface habitable par le prix local moyen DVF des maisons. Un repère complémentaire utilise le prix au m² des ventes détaillées filtrées selon les critères actifs ; il présente la médiane et l'intervalle interquartile d'une extrapolation à la surface du logement. Ce n'est pas une expertise et les caractéristiques non comparées (état, garage, emplacement précis) ne sont pas ajustées.
- Le tableau comparatif peut être filtré par année et trié par date, prix, surface ou terrain ; l'export CSV reprend les lignes visibles après ces filtres. L'évolution annuelle affiche les ventes et prix médians de l'échantillon DPE actuellement sélectionné. La fourchette comparative extrapole le prix médian au m² à la surface du profil et indique le nombre de mutations retenues.
- Le prix et la date d'achat permettent une comparaison avec ces repères DVF, pas le calcul d'une plus-value nette ou réalisée : frais d'acquisition, travaux et caractéristiques précises du bien ne sont pas pris en compte.
- Les comparables détaillés sont téléchargés à la demande depuis les partitions départementales DVF géolocalisées publiées sur data.gouv.fr. Les années courantes sont prises en compte dès qu'une partition départementale est publiée ; les partitions absentes de l'année courante sont ignorées et la période réellement utilisée est affichée. Les archives consultées sont gardées dans un cache mémoire borné pendant l'exécution du serveur, afin d'éviter de les retélécharger à chaque changement de filtre. Les ventes sont filtrées localement par type de maison, rayon, surface bâtie, pièces et terrain. Le serveur ne sauvegarde pas les fichiers DVF ni les ventes ; les résultats détaillés exposent désormais au navigateur les identifiants cadastraux et coordonnées DVF des comparables, sans adresse. Les ventes multi-biens ou ambiguës sont exclues et les résultats détaillés sont masqués sous cinq transactions comparables. L'onglet « Transactions comparables » montre les points géolocalisés, les références cadastrales et un lien vers l'explorateur DVF officiel. Les points ne représentent pas les limites de la parcelle ; la position est celle publiée dans DVF.
- Le filtre DPE utilise l'export départemental BDNB du CSTB (`2026-02-b` par défaut), téléchargé à la demande. Pour limiter le transfert, le serveur lit par requêtes HTTP Range uniquement les trois tables nécessaires (DPE logement et relations bâtiment–DPE / bâtiment–parcelle), environ 33 Mo compressés par département, puis effectue la jointure localement. Un index de classes DPE par parcelle est conservé dans `.cache/bdnb-dpe.sqlite3`, ignoré par Git, et réutilisé après redémarrage. Le cache est réindexé après 90 jours ; réglez `BDNB_CACHE_TTL_DAYS` pour modifier cette durée ou `BDNB_VERSION` lorsqu'un nouveau millésime est disponible. La valeur `0` force une nouvelle indexation à chaque requête DPE. Les absences et parcelles reliées à plusieurs identifiants DPE ne sont pas assimilées à une classe unique. Jusqu'à 10 000 parcelles candidates sont vérifiées localement par défaut, sans appels individuels à l'API DPE. Le nombre vérifié et le nombre total de candidates sont affichés. Le DPE associé à la parcelle peut ne pas décrire exactement le logement vendu et n'est pas nécessairement celui en vigueur à la date de mutation.
- Pour Cournon-d'Auvergne, le calcul inclut les communes du Puy-de-Dôme et des départements limitrophes. Les annonces en ligne ne disposant pas d'un flux public gratuit et autorisé, elles sont ajoutées manuellement : aucun portail n'est scrappé.
- Les annonces suivies et la localisation restent dans le stockage du navigateur. Les annonces ont un statut manuel, une date de mise à jour et un historique des changements de prix saisis lors d'une modification. Le menu « Sauvegarder profil et annonces » exporte un fichier JSON (localisation, profil et annonces), que l'on peut restaurer dans le même navigateur ; la restauration remplace les données locales correspondantes. Conservez vous-même une copie de la sauvegarde. La carte utilise les tuiles OpenStreetMap ; la BAN, l'API géographique de l'État et l'API DVF sont interrogées pour leurs données.
- Un mode GitHub Pages statique peut publier un instantané des comparables calculé chaque semaine par GitHub Actions (`.github/workflows/deploy-pages.yml`). Avant de l'activer, configurez les secrets `HOME_LATITUDE` et `HOME_LONGITUDE`, ainsi que les variables Actions `HOME_CITY_CODE`, `HOME_DEPARTMENT_CODE` et `HOME_DEPARTMENTS`. Les critères de comparaison peuvent être réglés avec les variables `COMPARABLE_MIN_AREA`, `COMPARABLE_MAX_AREA`, `COMPARABLE_MIN_ROOMS`, `COMPARABLE_MAX_ROOMS`, `COMPARABLE_MIN_LAND`, `COMPARABLE_MAX_LAND` et `COMPARABLE_DPE` ; ils sont fixes pour chaque instantané. Le site GitHub Pages et son fichier `data/comparables.json` sont publics : les identifiants cadastraux et coordonnées des comparables y sont publiés. Le point exact de la maison est gardé dans les secrets et n'est pas écrit dans l'instantané ; la carte publique utilise le centre de la commune. Le profil personnel, les annonces suivies et les sauvegardes ne sont pas inclus dans le site publié. Dans Settings > Pages, choisissez GitHub Actions comme source, configurez les secrets/variables, puis lancez le workflow manuellement. Sans ces réglages, continuez à utiliser le mode local avec `python3 server.py`.

Pour forcer l'utilisation d'un nouveau millésime ou ajuster la durée du cache BDNB :

```sh
BDNB_VERSION=2026-02-b BDNB_CACHE_TTL_DAYS=90 python3 server.py
```
