# 🔧 Guide : Ajouter un nouveau type de question dans Qwest

Ce guide explique comment ajouter un nouveau type de question à Qwest sans créer d'erreurs. Il s'adresse aux développeurs humains et aux IA.

---

## 📋 Vue d'ensemble

Pour ajouter un nouveau type de question, il faut modifier **9 fichiers** dans un ordre précis :

1. `js/config.js` - Déclaration du type
2. `index.html` - Bouton dans l'interface
3. `js/questions.js` - Éditeur enseignant (3 endroits)
4. `js/game.js` - Affichage élève (2 endroits)
5. `css/game.css` - Styles interface élève
6. `css/modals.css` - Styles éditeur enseignant
7. `php/game.php` - Validation serveur (2 fonctions)
8. `js/importExport.js` - Import/Export local (validation + propriétés)
9. `Documentation/FORMAT_QUESTIONNAIRE.md` - Documentation IA

---

## ⚙️ ÉTAPE 1 : Déclaration du type (`js/config.js`)

### 1.1 Ajouter la constante du type

**Chercher** : `const QUESTION_TYPES = {`

**Modifier** en ajoutant votre nouveau type :

```javascript
const QUESTION_TYPES = {
    MULTIPLE: 'multiple',
    TRUEFALSE: 'truefalse',
    ORDER: 'order',
    FREETEXT: 'freetext',
    NOUVEAUTYPE: 'nouveautype'  // ← AJOUTER ICI
};
```

⚠️ **Important** : Utiliser des minuscules pour la valeur (ex: `'nouveautype'` et non `'nouveauType'`)

### 1.2 Ajouter le case dans le constructeur Question

**Chercher** : `class Question {` puis `switch(type) {`

**Ajouter** un nouveau `case` AVANT l'accolade de fermeture du switch :

```javascript
switch(type) {
    case QUESTION_TYPES.MULTIPLE:
        this.answers = [
            { text: '', correct: true },
            { text: '', correct: false },
            { text: '', correct: false },
            { text: '', correct: false }
        ];
        break;
    
    // ... autres cases existants (TRUEFALSE, ORDER, FREETEXT)
    
    case QUESTION_TYPES.NOUVEAUTYPE:
        // Définir la structure answers
        this.answers = [
            // Structure selon vos besoins
        ];
        // Ajouter des propriétés spécifiques si nécessaire
        this.proprieteSpeciale = valeurParDefaut;
        break;
}
```

**Exemples de structures `answers` :**
- **Choix simple** : `[{ text: '', correct: true }]`
- **Choix multiples** : `[{ text: '', correct: false }, { text: '', correct: false }]`
- **Ordre** : `[{ text: '', order: 1 }, { text: '', order: 2 }]`

---

## 🖼️ ÉTAPE 2 : Interface de sélection (`index.html`)

**Chercher** : `<div id="add-question-modal" class="modal">`

Puis chercher : `<div class="question-type-grid">`

**Ajouter** un nouveau bouton AVANT la balise fermante `</div>` :

```html
<div class="question-type-grid">
    <button class="question-type-btn" onclick="createQuestion('multiple')">
        <span class="type-icon">☑️</span>
        <span class="type-name">Choix multiple</span>
        <span class="type-desc">4 réponses possibles</span>
    </button>
    
    <!-- ... autres boutons existants ... -->
    
    <button class="question-type-btn" onclick="createQuestion('nouveautype')">
        <span class="type-icon">🆕</span>
        <span class="type-name">Nouveau Type</span>
        <span class="type-desc">Description courte</span>
    </button>
</div>
```

⚠️ **Important** : 
- Utiliser `onclick="createQuestion('nouveautype')"` avec la valeur en **minuscules**
- Choisir une icône emoji représentative

---

## ✏️ ÉTAPE 3 : Éditeur enseignant (`js/questions.js`)

### 3.1 Ajouter le label du type

**Chercher** : `function createQuestionCard(question, index) {`

Puis chercher : `const typeLabels = {`

**Ajouter** votre type dans l'objet :

```javascript
const typeLabels = {
    'multiple': '☑️ Choix multiple',
    'truefalse': '✓✗ Vrai / Faux',
    'order': '🔢 Ordre',
    'freetext': '✍️ Réponse libre',
    'nouveautype': '🆕 Nouveau Type'  // ← AJOUTER ICI
};
```

### 3.2 Ajuster l'affichage des stats (optionnel)

**Chercher** : `let statsText = '';` (dans la fonction `createQuestionCard`)

**Si** votre type nécessite un affichage spécial, ajouter un `else if` :

```javascript
// Stats selon le type
let statsText = '';
if (question.type === 'order') {
    statsText = `${question.answers.length} éléments`;
} else if (question.type === 'freetext') {
    const altCount = question.acceptedAnswers ? question.acceptedAnswers.length : 0;
    statsText = altCount > 0 ? `1 réponse + ${altCount} variante(s)` : '1 réponse attendue';
} else if (question.type === 'nouveautype') {
    statsText = 'Votre texte personnalisé';  // ← AJOUTER ICI
} else {
    statsText = `${correctCount} bonne(s) réponse(s)`;
}
```

### 3.3 Ajouter le case dans editQuestion

**Chercher** : `function editQuestion(index) {`

Puis chercher : `switch(question.type) {` (il y en a plusieurs, prendre le premier)

**Ajouter** un case AVANT l'accolade de fermeture :

```javascript
switch(question.type) {
    case QUESTION_TYPES.MULTIPLE:
        formHTML += renderMultipleChoiceEditor(question);
        break;
    case QUESTION_TYPES.TRUEFALSE:
        formHTML += renderTrueFalseEditor(question);
        break;
    case QUESTION_TYPES.ORDER:
        formHTML += renderOrderEditor(question);
        break;
    case QUESTION_TYPES.FREETEXT:
        formHTML += renderFreeTextEditor(question);
        break;
    case QUESTION_TYPES.NOUVEAUTYPE:
        formHTML += renderNouveauTypeEditor(question);  // ← AJOUTER ICI
        break;
}
```

### 3.4 Créer la fonction renderNouveauTypeEditor

**Chercher** : `function removeQuestionImage() {` 

**Ajouter APRÈS** cette fonction (ou avant les exports `// EXPORT VERS GLOBAL`) :

```javascript
function renderNouveauTypeEditor(question) {
    // Initialiser les propriétés si nécessaire (rétrocompatibilité)
    if (!question.proprieteSpeciale) question.proprieteSpeciale = valeurParDefaut;
    
    let html = '<div class="answers-editor nouveautype-editor">';
    html += '<p class="info-text">📝 Instructions pour ce type de question</p>';
    
    // Ajouter vos champs HTML personnalisés
    html += `
        <div class="form-group">
            <label>Votre champ :</label>
            <input type="text" 
                   id="nouveautype-champ" 
                   class="answer-input" 
                   placeholder="Exemple..."
                   value="${question.proprieteSpeciale || ''}">
        </div>
    `;
    
    html += '</div>';
    return html;
}
```

⚠️ **Sécurité rétrocompatibilité** :
- Toujours vérifier avec `question.propriete || ''` ou `question.propriete ? ... : ''`
- Initialiser les propriétés manquantes au début

### 3.5 Ajouter le case dans saveEditedQuestion

**Chercher** : `function saveEditedQuestion() {`

Puis chercher : `switch(question.type) {` (le deuxième switch dans ce fichier)

**Ajouter** un case :

```javascript
switch(question.type) {
    case QUESTION_TYPES.MULTIPLE:
        saveMultipleChoiceAnswers(question);
        break;
    case QUESTION_TYPES.TRUEFALSE:
        saveTrueFalseAnswers(question);
        break;
    case QUESTION_TYPES.ORDER:
        saveOrderAnswers(question);
        break;
    case QUESTION_TYPES.FREETEXT:
        saveFreeTextAnswers(question);
        break;
    case QUESTION_TYPES.NOUVEAUTYPE:
        saveNouveauTypeAnswers(question);  // ← AJOUTER ICI
        break;
}
```

### 3.6 Créer la fonction saveNouveauTypeAnswers

**Ajouter APRÈS** `renderNouveauTypeEditor` :

```javascript
function saveNouveauTypeAnswers(question) {
    // Récupérer les valeurs des champs
    const valeur = document.getElementById('nouveautype-champ').value.trim();
    
    // Sauvegarder dans la structure question
    question.proprieteSpeciale = valeur;
    question.answers[0].text = valeur; // Si applicable
}
```

---

## 🎮 ÉTAPE 4 : Interface élève (`js/game.js`)

### 4.1 Ajouter le case dans displayQuestion

**Chercher** : `function displayQuestion(question) {`

Puis chercher : `// Générer les réponses selon le type` suivi de `switch(question.type) {`

**Ajouter** un case AVANT l'accolade de fermeture :

```javascript
switch(question.type) {
    case 'multiple':
    case 'truefalse':
        // Code des boutons de réponse
        break;
        
    case 'order':
        // Code du drag & drop
        break;
        
    case 'freetext':
        // Code du textarea
        break;
        
    case 'nouveautype':
        html += `
            <div class="nouveautype-container">
                <!-- Votre HTML pour l'interface élève -->
                <button class="btn-validate-nouveautype" onclick="validateNouveauType()">
                    Valider
                </button>
            </div>
        `;
        break;
}
```

### 4.2 Initialisation spécifique (si nécessaire)

**Chercher** : `gameContainer.innerHTML = html;`

**Ajouter APRÈS** les blocs d'initialisation existants :

```javascript
gameContainer.innerHTML = html;

// Démarrer le timer
startQuestionTimer(question.time);

// Initialiser le drag & drop si question d'ordre
if (question.type === 'order') {
    initializeOrderDragDrop();
}

// Initialiser le compteur si question à réponse libre
if (question.type === 'freetext') {
    const textarea = document.getElementById('freetext-answer');
    const counter = document.getElementById('freetext-count');
    if (textarea && counter) {
        textarea.addEventListener('input', function() {
            counter.textContent = this.value.length;
        });
    }
}

// Initialiser votre nouveau type
if (question.type === 'nouveautype') {
    // Code d'initialisation spécifique
}
```

### 4.3 Créer la fonction de validation

**Chercher** : `function launchConfetti() {`

**Ajouter APRÈS** cette fonction (ou avant `// EXPORT VERS GLOBAL`) :

```javascript
async function validateNouveauType() {
    if (hasAnswered || timerState.isPaused === true) return;
    
    hasAnswered = true;
    const timeSpent = Date.now() - questionStartTime; // Millisecondes
    
    // Récupérer la réponse de l'élève
    const reponseEleve = document.getElementById('votre-champ').value;
    
    // Désactiver l'interface
    document.getElementById('votre-champ').disabled = true;
    const btn = document.querySelector('.btn-validate-nouveautype');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('selected');
    }
    
    // Envoyer la réponse au serveur
    await submitAnswer({ nouveautype: reponseEleve }, timeSpent);
    
    // Afficher un feedback
    showAnswerFeedback();
}
```

### 4.4 Exporter la fonction

**Chercher** : `// EXPORT VERS GLOBAL` puis chercher les lignes `window.validate...`

**Ajouter** :

```javascript
window.validateOrder = validateOrder;
window.validateFreeText = validateFreeText;
window.validateNouveauType = validateNouveauType;  // ← AJOUTER ICI
```

---

## 🎨 ÉTAPE 5 : Styles interface élève (`css/game.css`)

**Chercher** : `.btn-validate-order:disabled {`

**Ajouter APRÈS** ce bloc :

```css
.btn-validate-order:disabled {
    background: var(--gray-400);
    cursor: not-allowed;
}

/* ========================================
   NOUVEAU TYPE
   ======================================== */

.nouveautype-container {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
}

.btn-validate-nouveautype {
    width: 100%;
    padding: var(--space-lg);
    background: var(--success);
    color: white;
    border: none;
    border-radius: var(--radius-lg);
    font-size: 18px;
    font-weight: 700;
    cursor: pointer;
    transition: var(--transition-base);
}

.btn-validate-nouveautype:hover {
    background: var(--success-dark);
}

.btn-validate-nouveautype:disabled,
.btn-validate-nouveautype.selected {
    background: var(--gray-400);
    cursor: not-allowed;
}
```

---

## 🎨 ÉTAPE 6 : Styles éditeur enseignant (`css/modals.css`)

**Chercher** : `.info-text {` (vers la fin du fichier)

**Ajouter APRÈS** ce bloc :

```css
.info-text {
    background: var(--primary-light);
    padding: var(--space-md);
    border-radius: var(--radius-md);
    color: var(--primary-dark);
    font-size: 14px;
    margin-bottom: var(--space-md);
}

.nouveautype-editor .votre-classe-specifique {
    /* Vos styles personnalisés pour l'éditeur */
}
```

---

## 🔧 ÉTAPE 7 : Validation serveur (`php/game.php`)

### 7.1 Ajouter dans calculateQuestionScores

**Chercher** : `function calculateQuestionScores(&$session, $questionIndex) {`

#### A. Détermination de la réponse correcte

**Chercher** : `// Déterminer la bonne réponse` suivi de `switch ($question['type']) {`

**Ajouter** un case AVANT l'accolade de fermeture :

```php
switch ($question['type']) {
    case 'multiple':
    case 'truefalse':
        foreach ($question['answers'] as $index => $answer) {
            if ($answer['correct']) {
                $correctAnswer = $index;
                break;
            }
        }
        break;
    
    case 'order':
        $correctAnswer = array_map(function($a) { return $a['text']; }, $question['answers']);
        break;
        
    case 'freetext':
        $correctAnswer = $question['answers'][0]['text'];
        break;
        
    case 'nouveautype':
        $correctAnswer = /* votre logique */;
        break;
}
```

#### B. Vérification de la réponse

**Chercher** : `// Vérifier si correct` suivi de `switch ($question['type']) {` (c'est le DEUXIÈME switch dans cette fonction)

**Ajouter** un case :

```php
switch ($question['type']) {
    case 'multiple':
    case 'truefalse':
        $isCorrect = isset($playerAnswer['index']) && $playerAnswer['index'] === $correctAnswer;
        break;
    
    case 'order':
        $isCorrect = isset($playerAnswer['order']) && $playerAnswer['order'] === $correctAnswer;
        break;
        
    case 'freetext':
        if (isset($playerAnswer['freetext'])) {
            $userAnswer = $playerAnswer['freetext'];
            // ... logique de validation freetext
        }
        break;
        
    case 'nouveautype':
        if (isset($playerAnswer['nouveautype'])) {
            $userAnswer = $playerAnswer['nouveautype'];
            // Votre logique de validation
            $isCorrect = /* true ou false */;
        }
        break;
}
```

### 7.2 Ajouter dans calculateQuestionResults

**Chercher** : `function calculateQuestionResults(&$session, $questionIndex) {`

Puis chercher : `// Déterminer la bonne réponse` suivi de `switch ($question['type']) {`

**Ajouter** un case :

```php
switch ($question['type']) {
    case 'multiple':
    case 'truefalse':
        foreach ($question['answers'] as $index => $answer) {
            if ($answer['correct']) {
                $correctAnswer = $index;
                break;
            }
        }
        break;
    
    case 'order':
        $correctAnswer = array_map(function($a) { return $a['text']; }, $question['answers']);
        break;
        
    case 'freetext':
        $correctAnswer = $question['answers'][0]['text'];
        break;
        
    case 'nouveautype':
        $correctAnswer = /* votre logique */;
        break;
}
```

---

## 📦 ÉTAPE 8 : Import/Export local (`js/importExport.js`)

Cette étape est **CRITIQUE** : sans elle, les questionnaires générés par IA ou exportés localement ne pourront pas être importés !

### 8.1 Ajouter le type dans la validation

**Chercher** : `// Valider le type` suivi de `if (!['multiple',`

**Modifier** la ligne pour ajouter votre type :

```javascript
// Valider le type
if (!['multiple', 'truefalse', 'order', 'freetext', 'nouveautype'].includes(q.type)) {
    throw new Error(`Question ${index + 1} : type "${q.type}" invalide`);
}
```

⚠️ **Important** : Si vous oubliez cette étape, l'import affichera "type invalide" !

### 8.2 Ajouter l'export des propriétés spécifiques

**Chercher** : `// Ajouter les propriétés spécifiques à freetext` (dans la fonction `exportQuizLocally`)

**Ajouter APRÈS** ce bloc :

```javascript
// Ajouter les propriétés spécifiques à freetext
if (q.type === 'freetext') {
    if (q.caseSensitive !== undefined) {
        questionData.caseSensitive = q.caseSensitive;
    }
    if (q.acceptedAnswers) {
        questionData.acceptedAnswers = q.acceptedAnswers;
    }
}

// Ajouter les propriétés spécifiques à nouveautype
if (q.type === 'nouveautype') {
    if (q.proprieteSpeciale !== undefined) {
        questionData.proprieteSpeciale = q.proprieteSpeciale;
    }
    // Ajouter toutes vos propriétés personnalisées ici
}
```

### 8.3 Ajouter l'import des propriétés spécifiques

**Chercher** : `// Importer les propriétés spécifiques à freetext` (dans la fonction `handleImportFile`)

**Ajouter APRÈS** ce bloc :

```javascript
// Importer les propriétés spécifiques à freetext
if (q.type === 'freetext') {
    if (q.caseSensitive !== undefined) {
        question.caseSensitive = q.caseSensitive;
    }
    if (q.acceptedAnswers) {
        question.acceptedAnswers = q.acceptedAnswers;
    }
}

// Importer les propriétés spécifiques à nouveautype
if (q.type === 'nouveautype') {
    if (q.proprieteSpeciale !== undefined) {
        question.proprieteSpeciale = q.proprieteSpeciale;
    }
    // Importer toutes vos propriétés personnalisées ici
}
```

⚠️ **Important** : 
- Sans l'étape 8.2, les propriétés ne seront pas sauvegardées lors de l'export
- Sans l'étape 8.3, les propriétés seront perdues lors de l'import
- Ces propriétés sont en PLUS de celles déjà gérées par le constructeur `Question`

---

## 📄 ÉTAPE 9 : Documentation IA (`Documentation/FORMAT_QUESTIONNAIRE.md`)

### 9.1 Ajouter la section du nouveau type

**Chercher** : `### 4. Réponse libre (freetext)`

**Ajouter APRÈS** cette section complète :

```markdown
### 5. Nouveau Type (nouveautype)
Description du type de question.

```json
{
  "type": "nouveautype",
  "question": "Votre question ?",
  "time": 30,
  "imageUrl": "https://example.com/image.jpg",
  "proprieteSpeciale": "valeur",
  "answers": [
    {"text": "Réponse", "correct": true}
  ]
}
```

**Spécificités nouveautype :**
- `proprieteSpeciale` : Description de la propriété
- `answers` : Structure et signification
```

### 9.2 Mettre à jour les règles

**Chercher** : `## Règles importantes`

Puis chercher la ligne : `3. **type** : Doit être`

**Modifier** pour ajouter votre type :

```markdown
3. **type** : Doit être "multiple", "truefalse", "order", "freetext" ou "nouveautype"
```

### 9.3 Ajouter un exemple complet

**Chercher** : `## Exemple complet`

**Ajouter** une question de votre nouveau type dans le tableau `questions` de l'exemple JSON.

---

## ✅ CHECKLIST FINALE

Avant de tester, vérifier que TOUS ces points sont faits :

### Fichiers JavaScript
- [ ] `js/config.js` - Constante ajoutée dans QUESTION_TYPES
- [ ] `js/config.js` - Case ajouté dans Question constructor
- [ ] `js/questions.js` - Label ajouté dans typeLabels
- [ ] `js/questions.js` - Stats personnalisées (optionnel)
- [ ] `js/questions.js` - Case ajouté dans editQuestion
- [ ] `js/questions.js` - Fonction renderXxxEditor créée
- [ ] `js/questions.js` - Case ajouté dans saveEditedQuestion
- [ ] `js/questions.js` - Fonction saveXxxAnswers créée
- [ ] `js/game.js` - Case ajouté dans displayQuestion
- [ ] `js/game.js` - Initialisation spécifique (optionnel)
- [ ] `js/game.js` - Fonction validateXxx créée
- [ ] `js/game.js` - Fonction exportée dans window
- [ ] `js/importExport.js` - Type ajouté dans la validation
- [ ] `js/importExport.js` - Export des propriétés spécifiques
- [ ] `js/importExport.js` - Import des propriétés spécifiques

### Fichiers HTML/CSS
- [ ] `index.html` - Bouton ajouté dans la modal
- [ ] `css/game.css` - Styles container + bouton validation
- [ ] `css/modals.css` - Styles éditeur (si nécessaire)

### Fichiers PHP
- [ ] `php/game.php` - Case dans calculateQuestionScores - détermination réponse
- [ ] `php/game.php` - Case dans calculateQuestionScores - vérification réponse
- [ ] `php/game.php` - Case dans calculateQuestionResults

### Documentation
- [ ] `Documentation/FORMAT_QUESTIONNAIRE.md` - Section type ajoutée
- [ ] `Documentation/FORMAT_QUESTIONNAIRE.md` - Règles mises à jour
- [ ] `Documentation/FORMAT_QUESTIONNAIRE.md` - Exemple complet ajouté

---

## 🐛 Problèmes courants et solutions

### Problème 1 : "La modal s'ouvre vide"
**Cause** : Fonction renderXxxEditor non définie ou erreur JavaScript  
**Solution** : Vérifier la console (F12) et s'assurer que la fonction existe

### Problème 2 : "Les anciennes questions ne se chargent plus"
**Cause** : Pas de vérification de propriétés manquantes  
**Solution** : Ajouter `if (!question.propriete) question.propriete = default;` au début de renderXxxEditor

### Problème 3 : "La modal s'ouvre scrollée en bas"
**Cause** : Pas de reset du scroll  
**Solution** : Le reset est automatique dans editQuestion. Si le problème persiste, chercher `modal.classList.add('active');` et vérifier que le code de reset du scroll existe juste après :
```javascript
const modalBody = modal.querySelector('.modal-body');
if (modalBody) {
    modalBody.scrollTop = 0;
}
```

### Problème 4 : "L'élève ne peut pas répondre"
**Cause** : Fonction validateXxx non exportée ou format de réponse incorrect  
**Solution** : Vérifier l'export dans les `window.validateXxx` et le format `await submitAnswer({ clé: valeur }, timeSpent)`

### Problème 5 : "Les points ne sont pas calculés"
**Cause** : Switch PHP incomplet  
**Solution** : Vérifier que le case est bien ajouté dans LES DEUX fonctions PHP (calculateQuestionScores ET calculateQuestionResults)

### Problème 6 : "Le type n'apparaît pas dans la liste"
**Cause** : Bouton non ajouté ou onclick incorrect  
**Solution** : Vérifier dans index.html que `onclick="createQuestion('nouveautype')"` utilise bien des minuscules

### Problème 7 : "Erreur 'QUESTION_TYPES.NOUVEAUTYPE is not defined'"
**Cause** : Constante non ajoutée dans config.js  
**Solution** : Vérifier que la constante existe bien dans l'objet QUESTION_TYPES

### Problème 8 : "Erreur import : type 'nouveautype' invalide"
**Cause** : Type non ajouté dans la validation de importExport.js  
**Solution** : Chercher `if (!['multiple', 'truefalse', 'order'` dans importExport.js et ajouter votre type à la liste

### Problème 9 : "Les propriétés personnalisées sont perdues à l'import/export"
**Cause** : Propriétés non gérées dans importExport.js  
**Solution** : Ajouter les blocs d'export et d'import des propriétés spécifiques dans importExport.js (voir étape 8.2 et 8.3)

---

## 💡 Conseils pour une intégration propre

1. **Toujours tester la rétrocompatibilité** : Les anciens questionnaires doivent continuer à fonctionner
2. **Utiliser des vérifications défensives** : `question.prop ? question.prop : 'default'`
3. **Respecter les conventions de nommage** : minuscules pour les valeurs de type
4. **Tester sur mobile** : Vérifier l'affichage responsive
5. **Documenter clairement** : Mettre à jour FORMAT_QUESTIONNAIRE.md avec précision
6. **Valider côté serveur** : Ne jamais faire confiance aux données client
7. **Chercher avant d'ajouter** : Utiliser Ctrl+F pour localiser précisément où insérer le code

---

## 📚 Ressources

- **Exemple complet** : Voir le type `freetext` pour une implémentation de référence
- **Structure de données** : Voir `js/config.js` pour les structures existantes
- **Styles disponibles** : Variables CSS dans `css/main.css` (chercher `:root {`)

---

**Dernière mise à jour** : Décembre 2024  
**Version** : 1.1 (sans numéros de lignes)

