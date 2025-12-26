// ============================================
// MODULE: FILTRE DE PROFANITÉ
// Description: Liste de mots interdits en français (contexte scolaire)
// ============================================

(function() {
    'use strict';

    const PROFANITY_FILTER = {
        // Liste de mots interdits (en minuscules)
        blacklist: [
            // Insultes et vulgarités courantes
            'merde', 'putain', 'con', 'connard', 'connasse', 'salaud', 'salope',
            'enculé', 'encule', 'pute', 'bordel', 'chier', 'foutre',
            
            // Termes offensants
            'crétin', 'débile', 'abruti', 'idiot', 'imbécile', 'imbecile',
            'taré', 'tare', 'dégénéré', 'degenere',
            
            // Termes sexuels
            'sexe', 'penis', 'pénis', 'vagin', 'bite', 'couilles',
            'cul', 'chatte', 'seins', 'nichons',
            
            // Termes discriminatoires
            'pédé', 'pede', 'tapette', 'gouine', 'nègre', 'negre',
            'youpin', 'bougnoule', 'arabe', 'bicot',
            
            // Termes violents
            'tuer', 'mort', 'suicide', 'bombe', 'arme', 'flingue',
            'poignard', 'couteau', 'terroriste',
            
            // Drogues
            'drogue', 'cannabis', 'shit', 'beuh', 'cocaine',
            'heroine', 'héroïne', 'ecstasy',
            
            // Variantes avec leet speak
            'c0n', 'p*te', 'm3rd3', 'f*ck', 'sh*t',
            
            // Termes problématiques en contexte scolaire
            'nazi', 'hitler', 'raciste', 'fasciste',
            
            // Ajouts contextuels
            'nul', 'pourri', 'moche', 'laid'
        ],
        
        /**
         * Vérifie si un texte contient des mots interdits
         */
        isClean: function(text) {
            if (!text || typeof text !== 'string') {
                return true;
            }
            
            const normalizedText = this.normalize(text);
            
            // Vérifier chaque mot interdit
            for (let word of this.blacklist) {
                const regex = new RegExp('\\b' + word + '\\b', 'i');
                if (regex.test(normalizedText)) {
                    return false;
                }
            }
            
            return true;
        },
        
        /**
         * Normalise le texte pour la vérification
         */
        normalize: function(text) {
            return text
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '') // Retirer les accents
                .replace(/[^a-z0-9\s]/g, '') // Retirer caractères spéciaux
                .replace(/\s+/g, ' ') // Normaliser les espaces
                .trim();
        },
        
        /**
         * Trouve les mots interdits dans un texte
         */
        findBadWords: function(text) {
            if (!text || typeof text !== 'string') {
                return [];
            }
            
            const normalizedText = this.normalize(text);
            const found = [];
            
            for (let word of this.blacklist) {
                const regex = new RegExp('\\b' + word + '\\b', 'i');
                if (regex.test(normalizedText)) {
                    found.push(word);
                }
            }
            
            return found;
        },
        
        /**
         * Affiche un message d'erreur approprié
         */
        getErrorMessage: function(text) {
            const badWords = this.findBadWords(text);
            if (badWords.length === 0) {
                return '';
            }
            
            return 'Le texte contient des termes inappropriés pour un contexte scolaire. Veuillez choisir un texte respectueux.';
        }
    };

    // Export
    window.PROFANITY_FILTER = PROFANITY_FILTER;

})();
