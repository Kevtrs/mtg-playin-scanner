# MTG Playin Scanner — PWA iPhone

Application web statique : reconnaissance visuelle locale avec CollectorVision, identification exacte via Scryfall, puis vérification du prix public de rachat Playin. Elle ne se connecte à aucun compte et n’ajoute rien au panier.

Le moteur [CollectorVision](https://github.com/HanClinto/CollectorVision), ses modèles et son catalogue sont distribués sous licence AGPL-3.0. Le premier lancement télécharge environ 40 Mo, ensuite mis en cache sur l’appareil.

## Mise en ligne (très simple)

1. Sur GitHub, crée un dépôt public nommé `mtg-playin-scanner` sans ajouter de README.
2. Dans ce dossier, exécute :

   ```bash
   git init
   git add .
   git commit -m "PWA MTG Playin Scanner"
   git branch -M main
   git remote add origin https://github.com/TON-PSEUDO/mtg-playin-scanner.git
   git push -u origin main
   ```

3. Dans le dépôt GitHub : **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Attends la coche verte dans l’onglet **Actions**, puis ouvre `https://TON-PSEUDO.github.io/mtg-playin-scanner/`.

## Installation iPhone

1. Ouvre l’URL dans **Safari** (pas dans le navigateur intégré d’une autre app).
2. Appuie sur **Partager**.
3. Choisis **Sur l’écran d’accueil**, puis **Ajouter**.
4. Lance l’icône et autorise la caméra au premier démarrage.

GitHub Pages fournit HTTPS : c’est indispensable à `getUserMedia`, donc la caméra fonctionne une fois le site publié.

## Scanner et gérer une pile

- La vue **Scanner** garde les prix normal/foil sur la caméra. Une carte maintenue devant l’objectif reste verrouillée après son ajout, même après plusieurs minutes.
- Une autre carte reconnue est acceptée immédiatement. Pour scanner deux exemplaires identiques, retire complètement la carte et attends « Cadre libre » (au moins trois images sans carte, environ deux secondes) avant de présenter le suivant. Un échec de mise au point seul ne réarme pas le scanner.
- La vue **Collection** met la caméra en pause et affiche une liste compacte. Touche une ligne pour choisir sa finition ou supprimer un exemplaire. « Annuler » restaure la dernière suppression.
- Recherche par nom/édition, filtre prix min/max et période, tris récents/anciens ou prix croissant/décroissant. Les prix inconnus restent à la fin des tris de prix et sont exclus des bornes de prix.
- Les filtres utilisent le prix unitaire de la finition choisie. Le sous-total concerne toute la sélection, même si seules 30 lignes sont affichées. « Afficher 30 de plus » charge la suite.
- L’historique existant est préservé. Les scans anciens sans date restent dans « Toutes les dates » ; les miniatures sont sauvegardées pour les nouveaux scans.

### Références d’interface et vérification

La liste compacte et la barre de filtres s’inspirent des [exemples Flowbite](https://flowbite.com/docs/components/tables/), sans dépendance UI supplémentaire. `npm test` vérifie l’anti-doublon, le réarmement après retrait et les filtres/tris combinés.

## Prix Playin

Après chaque reconnaissance, l’application consulte la recherche publique Playin via le lecteur public Jina AI, sélectionne l’impression la plus proche de l’édition Scryfall et affiche le prix Mint/Nmint FR ou EN. Seuls le nom public de la carte et la page publique Playin sont envoyés au relais ; aucun compte, cookie ou panier n’est utilisé. Le bouton **Chercher sur Playin** reste disponible pour vérifier manuellement une variante.

## Développement local

```bash
npm install
npm run dev
```

`localhost` est autorisé pour tester la caméra sur ordinateur. Sur iPhone, utilise la version HTTPS publiée.
