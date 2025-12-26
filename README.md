# 🎯 QWEST - Quiz Interactif

Application web de quiz en temps réel type Kahoot pour l'éducation.

## 📦 INSTALLATION

### Avec XAMPP (Windows/Mac/Linux)

1. Copiez le dossier `qwest` dans `C:\xampp\htdocs\`
2. Démarrez Apache dans XAMPP Control Panel
3. Ouvrez votre navigateur : `http://localhost/qwest`

### Structure des fichiers

```
qwest/
├── index.html          # Page principale
├── css/               # Feuilles de style
│   ├── main.css
│   ├── modals.css
│   ├── mobile.css
│   ├── game.css
│   ├── control.css
│   └── imageGallery.css
├── js/                # Modules JavaScript
│   ├── config.js
│   ├── utils.js
│   ├── profanityFilter.js
│   ├── dragAndDrop.js
│   ├── history.js
│   ├── auth.js
│   ├── questions.js
│   ├── saveLoad.js
│   ├── importExport.js
│   ├── imageGallery.js
│   ├── game.js
│   ├── control.js
│   └── main.js
├── php/               # Backend
│   ├── game.php
│   ├── control.php
│   ├── sse.php
│   └── data/          # Données (créé automatiquement)
├── Documentation/     # Guides développeur
│   ├── AJOUTER_TYPE_QUESTION.md
│   └── FORMAT_QUESTIONNAIRE.md
└── images/            # Images (vide pour l'instant)
```

## 🚀 UTILISATION

### Mode Professeur

1. Sur la page d'accueil, entrez le code : `prof123`
2. Créez vos questions
3. Sauvegardez le questionnaire
4. Notez les codes générés

### Mode Élève

1. Entrez le code de partie fourni par le prof
2. (Phase 2 en développement)

## ⚙️ CONFIGURATION

### Mot de passe professeur

Le mot de passe prof est : `prof123`

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
- Page d'accueil avec champ code
- Authentification prof (hashée)
- Interface création questionnaires
- **4 types de questions** :
  - ☑️ Choix multiple (1 bonne réponse)
  - ✓✗ Vrai / Faux
  - 🔢 Remettre dans l'ordre
  - ✍️ **Réponse libre** (texte, insensible à la casse, variantes acceptées)
- Jusqu'à 150 questions par quiz
- **Galerie d'images Pixabay** intégrée
- **Import/Export local** (JSON)
- Système sauvegarde/chargement en ligne
- **Annuler/Répéter** (historique des actions)
- **Drag & Drop** pour réorganiser les questions
- Captcha de sécurité
- Filtre mots inappropriés
- **Aperçu des images** dans la liste des questions
- Design moderne et responsive
- Génération de codes (modification + partie)

### ✅ Phase 2 - Partie Élève
- Page de sélection collège + avatar animal
- **80+ animaux** disponibles (rotation automatique)
- Salle d'attente avec liste joueurs en temps réel
- Synchronisation temps réel (Server-Sent Events)
- Affichage questions avec timer
- **4 types de questions interactives** :
  - Choix multiple avec boutons
  - Vrai/Faux
  - Remettre dans l'ordre (drag & drop)
  - **Réponse libre** (champ texte, validation automatique)
- Système de scoring automatique
- Affichage résultats après chaque question
- Top 3 animé avec podium
- Résultats finaux avec confettis
- Reconnexion automatique

### ✅ Phase 3 - Pilotage
- Popup de pilotage complète
- Configuration initiale (collège, options)
- Mode manuel/automatique pour les questions
- **Affichage participants en temps réel** avec :
  - Statut connexion (🟢/🔴)
  - **Nombre de bonnes réponses / total** (ex: ✓ 15/20)
  - Score en points
  - Modification manuelle des scores
- Contrôles :
  - ▶️ Lancer la partie
  - ⏸️ Pause / Reprendre
  - ⏭️ Question suivante (mode manuel)
  - ⏹️ Terminer la partie
- Barre de progression
- **📊 Tableau de suivi complet** :
  - Mise à jour en temps réel
  - Calcul automatique note sur 20
  - Pourcentage de réussite
  - Export CSV avec toutes les données
  - Impression optimisée
- Gestion reconnexion élèves
- **Anti-collision collèges** (sessions séparées)

## 🔧 OUTILS DÉVELOPPEUR

### Documentation technique

Le dossier `Documentation/` contient des guides pour étendre Qwest :

- **`AJOUTER_TYPE_QUESTION.md`** : Guide complet pour ajouter un nouveau type de question
  - 9 fichiers à modifier
  - Checklist de 24 points
  - Exemples de code
  - Dépannage des problèmes courants
  - Utilise des patterns de recherche (indépendant des numéros de ligne)

- **`FORMAT_QUESTIONNAIRE.md`** : Format JSON pour la génération par IA
  - Structure des questionnaires
  - Format de chaque type de question
  - Règles de validation
  - Exemples complets

### Import/Export local

Les questionnaires peuvent être exportés/importés au format JSON :
- Sauvegarde locale des questionnaires
- Compatibilité avec la génération par IA
- Préservation de toutes les propriétés (images, temps, options)
- Validation stricte à l'import

## 🛠️ DÉPANNAGE

### Les questions ne se sauvegardent pas

Vérifiez que le dossier `php/data` existe et est accessible en écriture.

### Erreur 404

Vérifiez qu'Apache est bien démarré dans XAMPP.

### Le captcha ne fonctionne pas

Actualisez la page (F5).

---

Créé pour l'éducation 🎓
