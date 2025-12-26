# Format de Questionnaire Qwest - Guide pour IA

## Structure JSON

```json
{
  "name": "Nom du questionnaire",
  "version": "1.0",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "questionsCount": 4,
  "questions": [...]
}
```

## Types de questions

### 1. Question à choix multiples (multiple)
Une seule bonne réponse parmi plusieurs options.

```json
{
  "type": "multiple",
  "question": "Quelle est la capitale de la France ?",
  "time": 30,
  "imageUrl": "https://example.com/image.jpg",
  "answers": [
    {"text": "Paris", "correct": true},
    {"text": "Lyon", "correct": false},
    {"text": "Marseille", "correct": false},
    {"text": "Bordeaux", "correct": false}
  ]
}
```

### 2. Vrai/Faux (truefalse)
Question avec deux options : Vrai ou Faux.

```json
{
  "type": "truefalse",
  "question": "La Terre est ronde.",
  "time": 20,
  "imageUrl": "https://example.com/terre.jpg",
  "answers": [
    {"text": "Vrai", "correct": true},
    {"text": "Faux", "correct": false}
  ]
}
```

### 3. Ordre (order)
Les élèves doivent ordonner les réponses dans le bon ordre.
L'ordre dans le JSON = ordre correct.

```json
{
  "type": "order",
  "question": "Ordonne ces planètes du Soleil vers l'extérieur :",
  "time": 40,
  "answers": [
    {"text": "Mercure", "correct": true},
    {"text": "Vénus", "correct": true},
    {"text": "Terre", "correct": true},
    {"text": "Mars", "correct": true}
  ]
}
```

### 4. Réponse libre (freetext)
L'élève doit saisir une réponse textuelle (300 caractères max).

```json
{
  "type": "freetext",
  "question": "Quelle est la capitale de la France ?",
  "time": 30,
  "imageUrl": "https://example.com/france.jpg",
  "caseSensitive": false,
  "answers": [
    {"text": "Paris", "correct": true}
  ],
  "acceptedAnswers": ["paris", "PARIS", "Île-de-France"]
}
```

**Spécificités freetext :**
- `caseSensitive` (optionnel, défaut: `false`) : si `true`, respecte majuscules/minuscules
- `answers[0].text` : la réponse correcte principale
- `acceptedAnswers` (optionnel) : liste de variantes acceptées (orthographe, synonymes, etc.)

## Images (optionnel)

Le champ **imageUrl** est optionnel. Si vous voulez ajouter une image :
- Utilisez une URL publique d'image (format : `https://...jpg`, `https://...png`, etc.)
- L'URL doit pointer directement vers le fichier image
- Vous pouvez omettre ce champ si vous n'avez pas d'image

```json
{
  "type": "multiple",
  "question": "Quelle est la capitale de la France ?",
  "time": 30,
  "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/La_Tour_Eiffel_vue_de_la_Tour_Saint-Jacques%2C_Paris_ao%C3%BBt_2014_%282%29.jpg/800px-La_Tour_Eiffel_vue_de_la_Tour_Saint-Jacques%2C_Paris_ao%C3%BBt_2014_%282%29.jpg",
  "answers": [...]
}
```

## Règles importantes

1. **name** : Nom du questionnaire (50 caractères max)
2. **time** : Temps en secondes (5 à 300)
3. **type** : Doit être "multiple", "truefalse", "order" ou "freetext"
4. **imageUrl** : OPTIONNEL - URL directe vers une image (ex: `https://example.com/image.jpg`)
5. **answers** : 
   - **multiple** : 2 à 6 réponses, UNE seule avec `correct: true`
   - **truefalse** : Exactement 2 réponses ("Vrai" et "Faux")
   - **order** : 2 à 6 réponses, toutes avec `correct: true`, l'ordre dans le JSON = ordre correct
   - **freetext** : 1 réponse avec `correct: true`, champs optionnels `caseSensitive` et `acceptedAnswers`

## Exemple complet

```json
{
  "name": "Quiz Histoire - Révolution Française",
  "version": "1.0",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "questionsCount": 4,
  "questions": [
    {
      "type": "multiple",
      "question": "En quelle année a commencé la Révolution Française ?",
      "time": 30,
      "imageUrl": "https://example.com/revolution.jpg",
      "answers": [
        {"text": "1789", "correct": true},
        {"text": "1792", "correct": false},
        {"text": "1799", "correct": false},
        {"text": "1804", "correct": false}
      ]
    },
    {
      "type": "truefalse",
      "question": "Louis XVI a été guillotiné en 1793.",
      "time": 20,
      "answers": [
        {"text": "Vrai", "correct": true},
        {"text": "Faux", "correct": false}
      ]
    },
    {
      "type": "order",
      "question": "Ordonne ces événements chronologiquement :",
      "time": 40,
      "answers": [
        {"text": "Prise de la Bastille", "correct": true},
        {"text": "Déclaration des droits de l'homme", "correct": true},
        {"text": "Exécution de Louis XVI", "correct": true},
        {"text": "Coup d'État du 18 Brumaire", "correct": true}
      ]
    },
    {
      "type": "freetext",
      "question": "Quel roi a été exécuté pendant la Révolution Française ?",
      "time": 25,
      "caseSensitive": false,
      "answers": [
        {"text": "Louis XVI", "correct": true}
      ],
      "acceptedAnswers": ["Louis 16", "Louis seize", "Louis Seize", "LOUIS XVI"]
    }
  ]
}
```
