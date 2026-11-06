# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Maison & Marché : tableau de bord immobilier français (ventes DVF comparables, BDNB). Interface et doc en français. Les règles détaillées sont dans [AGENTS.md](AGENTS.md) et [README.md](README.md) ; ne pas les dupliquer ici.

## Commandes

Aucune dépendance (Python 3 stdlib, JS sans build).

```sh
python3 server.py                  # http://127.0.0.1:8000 (PORT=4173 pour changer)
python3 -m unittest discover tests # tous les tests
python3 -m unittest tests.test_snapshot_features.SnapshotFeatureTests.<nom_du_test>  # un test
python3 -m py_compile server.py scripts/generate_pages_data.py   # à lancer après toute modif Python
git diff --check
```

Ne pas lancer `scripts/generate_pages_data.py` en local sans les variables `HOME_*` : il télécharge les archives DVF et BDNB.

## Architecture

Deux modes, un seul front (`index.html` + `src/main.js` + `src/market.js`) :

- **Local** : `server.py` sert les fichiers statiques et l'API `/api/dvf-comparables`. Il contient toute la logique de calcul (`parse_query`, `load_department_transactions`, `summarize`) et l'index BDNB SQLite (`.cache/bdnb-dpe.sqlite3`, ignoré par git). Localisation lue depuis `config.local.js` (ignoré, jamais publié).
- **Pages (statique)** : `scripts/generate_pages_data.py` importe `server` et réutilise `parse_query`/`summarize`/`load_department_transactions` pour produire `data/comparables.json` (+ `data/snapshot-history.json`, agrégats seulement). Ne pas dupliquer la logique de `server.py` dans le générateur.
- Le front bascule via `window.STATIC_DATA_MODE` (`static-config.js` le met à `false` ; le générateur écrit sa propre version dans `_site`). En mode statique, `main.js` lit `./data/comparables.json` au lieu de l'API, avec des chemins relatifs (URL de projet GitHub Pages).
- `.github/workflows/deploy-pages.yml` : hebdomadaire, secrets pour les coordonnées de la maison, variables pour communes/départements/critères, commit de `snapshot-history.json` (`contents: write`), puis déploiement de `_site`.

## Pièges

- `data/comparables.json` et le site Pages sont publics : coordonnées DVF et références cadastrales y sont exposées, jamais le point exact de la maison, le profil ni les annonces (stockés dans le navigateur).
- Années de construction / DPE : issus de l'index BDNB ; références ambiguës ou absentes restent inconnues, ne rien deviner.
- Le test importe `scripts/generate_pages_data.py` via `importlib` (pas un paquet) ; `server` s'importe depuis la racine.
