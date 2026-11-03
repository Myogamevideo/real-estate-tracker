# Instructions pour les agents

## Projet

Maison & Marché est un tableau de bord immobilier français. L'application fonctionne localement avec un serveur Python (`server.py`) ou en version statique sur GitHub Pages, où GitHub Actions publie un instantané périodique des ventes comparables.

## Consignes de développement

- Conserver l'interface et la documentation en français.
- Garder l'application locale fonctionnelle : `config.local.js` fournit la localisation locale et ne doit pas être publié.
- Ne jamais ajouter de coordonnées privées, secrets ou données personnelles au dépôt ou à l'instantané public.
- Le site GitHub Pages et `data/comparables.json` sont publics. Les coordonnées de ventes et références cadastrales incluses dans cet instantané sont donc accessibles publiquement.
- Les données personnelles du profil et les annonces suivies sont conservées dans le navigateur ; ne pas les exporter dans le site statique.
- Le générateur `scripts/generate_pages_data.py` réutilise la logique de calcul de `server.py`. Éviter de dupliquer cette logique.
- Les années de construction et les classes DPE des comparables proviennent de l'index BDNB local ; les références ambiguës ou absentes doivent rester inconnues plutôt que d'être devinées.
- Le workflow `.github/workflows/deploy-pages.yml` utilise des Actions secrets pour les coordonnées de la maison et des Actions variables pour les codes de commune et départements.
- L'historique public hebdomadaire contient uniquement des indicateurs agrégés. Le workflow l'enregistre dans `data/snapshot-history.json` avec les permissions `contents: write`.
- Ne pas lancer le générateur sans les variables et secrets requis : il télécharge les archives de données DVF et BDNB.

## Vérifications

- Après une modification Python, lancer `python3 -m py_compile server.py scripts/generate_pages_data.py`.
- Vérifier les changements avec `git diff --check`.
- Pour les changements du mode Pages, vérifier que les chemins relatifs fonctionnent sur une URL GitHub Pages de projet et que la configuration locale n'est pas incluse dans l'artefact publié.
