# 🎯 QWEST - Quiz Interactif

Application web de quiz en temps réel type Kahoot pour l'éducation. Design moderne, mobile-first et entièrement responsive.

## 📦 INSTALLATION

### Avec XAMPP (Windows/Mac/Linux)

1. Copiez le dossier `qwest` dans `C:\xampp\htdocs\`
2. Démarrez Apache dans XAMPP Control Panel
3. Ouvrez votre navigateur : `http://localhost/qwest`

### Structure des fichiers

```
qwest/
├── index.html          # Page principale
├── teacher-play.html   # Page "Je participe aussi" (enseignant)
├── projection.html     # Mode projection pour TBI
├── css/               # Feuilles de style
│   ├── main.css       # Styles principaux
│   ├── modals.css     # Styles des modales
│   ├── mobile.css     # Responsive mobile
│   ├── game.css       # Interface de jeu élève
│   ├── control.css    # Interface de pilotage
│   └── gallery.css    # Galerie d'images
├── js/                # Modules JavaScript
│   ├── config.js      # Configuration globale
│   ├── utils.js       # Fonctions utilitaires
│   ├── profanityFilter.js
│   ├── dragDrop.js    # Drag & Drop questions
│   ├── history.js     # Annuler/Répéter
│   ├── auth.js        # Authentification prof
│   ├── questions.js   # Gestion des questions
│   ├── saveLoad.js    # Sauvegarde/Chargement
│   ├── importExport.js # Import/Export JSON
│   ├── imageGallery.js # Galerie Pixabay
│   ├── animals.js     # Avatars animaux
│   ├── game.js        # Logique de jeu élève
│   ├── control.js     # Interface de pilotage
│   ├── sessionManager.js # Gestion sessions
│   ├── help.js        # Aide et astuces
│   └── main.js        # Point d'entrée
├── php/               # Backend
│   ├── game.php       # API jeu élève
│   ├── control.php    # API pilotage prof
│   ├── api.php        # Endpoints divers
│   └── data/          # Données (créé auto)
│       ├── quizzes/   # Questionnaires sauvegardés
│       └── sessions/  # Sessions de jeu
├── Documentation/     # Guides développeur
│   ├── AJOUTER_TYPE_QUESTION.md
│   └── FORMAT_QUESTIONNAIRE.md
└── images/            # Images Pixabay
```

## 🚀 UTILISATION

### Mode Professeur

1. Sur la page d'accueil, cliquez sur **"Créer un questionnaire"**
2. Entrez le mot de passe : `prof123`
3. Créez vos questions (jusqu'à 150)
4. Cliquez sur **🚀 Piloter** pour lancer la partie
5. Configurez les options de jeu
6. Partagez le code de partie avec vos élèves
7. Lancez la partie quand tout le monde est connecté

### Mode Élève

1. Sur la page d'accueil, entrez le **code de partie** fourni par le prof
2. Choisis ton **avatar animal** (80+ disponibles)
3. Attends dans la salle d'attente
4. Réponds aux questions dès que la partie commence !

### Mode "Je participe aussi" (Enseignant)

1. Dans la popup de pilotage, cliquez sur **🎯 Je participe aussi !**
2. Une nouvelle fenêtre s'ouvre avec l'interface élève
3. Choisissez votre avatar
4. Participez à la partie en même temps que vos élèves !

### Mode Projection

1. Dans la popup de pilotage, cliquez sur **📽️ Projection**
2. Une nouvelle fenêtre s'ouvre en plein écran
3. Projetez cette fenêtre sur votre TBI/vidéoprojecteur
4. Les élèves voient les questions et les résultats en temps réel

## ⚙️ CONFIGURATION

### Mot de passe professeur

Le mot de passe prof par défaut est : `prof123`

Pour le changer :
1. Ouvrez la console navigateur (F12)
2. Tapez : `hashPassword('votreNouveauMotDePasse').then(hash => console.log(hash))`
3. Copiez le hash affiché
4. Dans `js/config.js`, remplacez la valeur de `TEACHER_PASSWORD_HASH`

Exemple :
```javascript
// Pour le mot de passe "monMotDePasse"
// 1. Console : hashPassword('monMotDePasse').then(hash => console.log(hash))
// 2. Résultat : a1b2c3d4e5f6...
// 3. Dans config.js :
TEACHER_PASSWORD_HASH: 'a1b2c3d4e5f6...',
```

## 📋 FONCTIONNALITÉS COMPLÈTES

### ✅ Phase 1 - Création de questionnaires

- Page d'accueil épurée avec champ code
- Authentification prof sécurisée (hash SHA-256)
- Interface de création intuitive
- **4 types de questions** :
  - ☑️ **Choix multiple** (1 bonne réponse, 2-4 options)
  - ✓✗ **Vrai / Faux**
  - 🔢 **Remettre dans l'ordre** (2-6 éléments)
  - ✍️ **Réponse libre** (texte, insensible à la casse, variantes acceptées)
- Jusqu'à **150 questions** par quiz
- **Galerie d'images Pixabay** intégrée avec recherche
- **Import/Export local** (format JSON)
- Système sauvegarde/chargement en ligne avec codes
- **Annuler/Répéter** (historique complet des actions)
- **Drag & Drop** pour réorganiser les questions
- Captcha de sécurité anti-spam
- Filtre de mots inappropriés
- **Aperçu miniature** des images dans la liste
- Design moderne et responsive
- Génération automatique de codes (modification + partie)

### ✅ Phase 2 - Partie Élève

- Page de sélection avatar animal
- **80+ animaux différents** (rotation automatique anti-collision)
- Salle d'attente avec liste joueurs en temps réel
- Synchronisation temps réel via **Server-Sent Events (SSE)**
- Affichage questions avec timer visuel
- **4 types de questions interactives** :
  - Choix multiple avec boutons colorés
  - Vrai/Faux avec animation
  - Remettre dans l'ordre avec drag & drop tactile
  - **Réponse libre** avec champ texte et validation
- Système de **scoring automatique** (points bonus pour rapidité)
- Affichage résultats après chaque question
- **Top 3 animé** avec podium et confettis
- Écran de résultats finaux avec classement complet
- **Reconnexion automatique** en cas de déconnexion
- Support complet **mobile et tactile**
- Mode paysage optimisé

### ✅ Phase 3 - Interface de Pilotage

#### Popup de pilotage (Mobile-first)
- Design responsive adapté mobile/desktop
- Sections repliables pour économiser l'espace
- **En mobile** : organisation compacte optimisée
- **En desktop** : vue d'ensemble complète

#### Options de jeu
- ⚙️ **Mode manuel** : avancer manuellement entre questions
- 🏆 **Affichage Top 3** : après chaque question (activable)
- ⏱️ **Temps personnalisé** : forcer un temps identique pour toutes les questions
- 🎲 **Limite de questions** : sélection aléatoire d'un nombre de questions

#### Gestion des participants
- **Liste en temps réel** avec statut de connexion (🟢/🔴)
- Affichage du **nombre de bonnes réponses / total** (ex: ✓ 15/20)
- Score en points mis à jour automatiquement
- Modification manuelle des scores possible
- Compteur de participants connectés
- Bouton **🔄 Actualiser** pour rafraîchir la liste
- Bouton **🔄 Resynchroniser** pour débloquer les élèves

#### Contrôles de partie
- ▶️ **Lancer la partie** : démarrage avec compte à rebours
- ⏸️ **Pause / Reprendre** : mettre en pause n'importe quand
- ⏭️ **Question suivante** : avancer manuellement (mode manuel)
- ⏹️ **Terminer la partie** : fin anticipée
- 📊 **Tableau de suivi complet** : voir tous les résultats détaillés

#### Mode Projection
- 📽️ Fenêtre dédiée pour TBI/vidéoprojecteur
- Affichage des questions en grand format
- Compte à rebours visible
- Résultats et Top 3 animés
- Synchronisation automatique avec le pilotage

#### Mode "Je participe aussi"
- 🎯 Interface enseignant pour participer
- Même expérience que les élèves
- Fenêtre séparée avec contrôles compacts
- **En mobile** : interface optimisée et compacte

#### Tableau de suivi complet
- Vue détaillée de tous les participants
- Réponses question par question
- Calcul automatique **note sur 20**
- **Pourcentage de réussite** par élève
- Temps de réponse pour chaque question
- **Export CSV** avec toutes les données
- **Impression optimisée** pour archivage
- Statistiques globales de la classe

#### Fonctionnalités avancées
- **Aperçu de question** : prévisualiser avant de lancer
- Barre de progression visuelle
- Gestion automatique de la reconnexion élèves
- **Anti-collision sessions** : plusieurs parties simultanées possibles
- Polling optimisé pour connexions lentes
- Messages d'alerte personnalisés

## 📱 RESPONSIVE & MOBILE

### Optimisations mobiles
- **Design mobile-first** : conçu d'abord pour mobile
- Interface adaptée aux écrans tactiles
- Zones de toucher optimisées (44px minimum)
- Textes et boutons adaptés à la taille d'écran
- Grilles CSS pour organisation compacte
- Scroll optimisé et débordement géré
- Support mode paysage sur téléphones

### Adaptations spécifiques
- **Popup de pilotage** : disposition en grille compacte
- **Teacher-play** : contrôles réorganisés pour mobile
- **Page élève** : plein écran avec scroll intelligent
- **Projection** : responsive avec fallback

## 🔧 OUTILS DÉVELOPPEUR

### Documentation technique

Le dossier `Documentation/` contient des guides pour étendre Qwest :

#### `AJOUTER_TYPE_QUESTION.md`
Guide complet pour ajouter un nouveau type de question :
- 9 fichiers à modifier
- Checklist de 24 points
- Exemples de code détaillés
- Dépannage des problèmes courants
- Patterns de recherche (indépendant des numéros de ligne)

#### `FORMAT_QUESTIONNAIRE.md`
Format JSON pour la génération par IA :
- Structure des questionnaires
- Format de chaque type de question
- Règles de validation strictes
- Exemples complets et annotés

### Import/Export local

Les questionnaires peuvent être exportés/importés au format JSON :
- 📥 **Export** : sauvegarde locale complète
- 📤 **Import** : validation stricte des données
- 🤖 **Compatibilité IA** : format optimisé pour génération automatique
- 🎨 **Préservation complète** : images, temps, options, variantes
- ✅ **Validation** : vérification de l'intégrité à l'import

### Architecture technique

#### Frontend
- JavaScript modulaire (ES6+)
- CSS moderne (variables, grid, flexbox)
- Architecture événementielle
- Gestion d'état centralisée (APP_STATE)
- Pas de framework externe (vanilla JS)

#### Backend
- PHP 7.4+
- Architecture REST-like
- Gestion de sessions JSON
- Server-Sent Events (SSE) pour temps réel
- Polling avec throttling intelligent

#### Synchronisation temps réel
- **SSE** pour push serveur → client
- Reconnexion automatique avec backoff
- Ping/Pong pour maintien de connexion
- Gestion des déconnexions gracieuses

## 🛠️ DÉPANNAGE

### Les questions ne se sauvegardent pas
Vérifiez que le dossier `php/data` existe et est accessible en écriture :
```bash
chmod 755 php/data
chmod 755 php/data/quizzes
chmod 755 php/data/sessions
```

### Erreur 404 sur les requêtes PHP
- Vérifiez qu'Apache est bien démarré dans XAMPP
- Vérifiez que le fichier `.htaccess` est présent
- Vérifiez que `mod_rewrite` est activé

### Les élèves se déconnectent souvent
- Augmentez `PING_INTERVAL` dans `js/config.js` (ex: 15000 pour 15s)
- Vérifiez la qualité de la connexion réseau
- Utilisez le bouton "Resynchroniser" dans le pilotage

### Le captcha ne fonctionne pas
Actualisez la page (F5) ou videz le cache du navigateur.

### Les images Pixabay ne s'affichent pas
Vérifiez votre connexion internet et l'API Pixabay.

### Mode projection/teacher-play ne s'ouvre pas
Vérifiez que les popups ne sont pas bloquées par votre navigateur.

### Problèmes d'affichage mobile
- Videz le cache du navigateur
- Vérifiez que vous utilisez la dernière version des fichiers CSS
- Testez sur différents navigateurs (Chrome, Safari, Firefox)

## 🎓 CRÉDITS

**Créé pour l'éducation**

Application développée pour un usage pédagogique en collège.
- Design mobile-first et accessible
- Sans publicité ni tracking
- Open source et gratuit
- Hébergeable localement (XAMPP)

---

**Version actuelle** : 1.0  
**Dernière mise à jour** : Décembre 2024
