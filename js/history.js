// ============================================
// MODULE: HISTORY (Undo/Redo)
// Description: Gestion de l'historique des actions
// ============================================

(function() {
    'use strict';

    // État de l'historique
    const HISTORY_STATE = {
        past: [],      // Actions passées (pour undo)
        future: [],    // Actions annulées (pour redo)
        maxSize: 50    // Nombre max d'actions conservées
    };

    // ========================================
    // SAUVEGARDE D'UNE ACTION
    // ========================================
    
    function saveAction(action) {
        // Ajouter l'action au passé
        HISTORY_STATE.past.push(action);
        
        // Limiter la taille de l'historique
        if (HISTORY_STATE.past.length > HISTORY_STATE.maxSize) {
            HISTORY_STATE.past.shift();
        }
        
        // Vider le futur (on ne peut plus redo après une nouvelle action)
        HISTORY_STATE.future = [];
        
        updateHistoryButtons();
    }

    // ========================================
    // UNDO (Annuler)
    // ========================================
    
    function undoAction() {
        if (HISTORY_STATE.past.length === 0) return;
        
        // Récupérer la dernière action
        const action = HISTORY_STATE.past.pop();
        
        // Inverser l'action selon son type
        switch(action.type) {
            case 'edit':
                // Restaurer l'ancienne question
                APP_STATE.questions[action.index] = JSON.parse(action.oldData);
                break;
                
            case 'delete':
                // Restaurer la question supprimée
                APP_STATE.questions.splice(action.index, 0, JSON.parse(action.data));
                break;
                
            case 'move':
                // Inverser le déplacement
                const reverseDirection = action.direction === 1 ? -1 : 1;
                const reverseIndex = action.index + action.direction;
                [APP_STATE.questions[action.index], APP_STATE.questions[reverseIndex]] = 
                [APP_STATE.questions[reverseIndex], APP_STATE.questions[action.index]];
                break;
        }
        
        // Ajouter au futur pour permettre le redo
        HISTORY_STATE.future.push(action);
        
        // Rafraîchir l'affichage
        renderQuestionsList();
        updateHistoryButtons();
    }

    // ========================================
    // REDO (Répéter)
    // ========================================
    
    function redoAction() {
        if (HISTORY_STATE.future.length === 0) return;
        
        // Récupérer l'action à refaire
        const action = HISTORY_STATE.future.pop();
        
        // Refaire l'action selon son type
        switch(action.type) {
            case 'edit':
                // Réappliquer la modification
                APP_STATE.questions[action.index] = JSON.parse(action.newData);
                break;
                
            case 'delete':
                // Supprimer à nouveau
                APP_STATE.questions.splice(action.index, 1);
                break;
                
            case 'move':
                // Refaire le déplacement
                const newIndex = action.index + action.direction;
                [APP_STATE.questions[action.index], APP_STATE.questions[newIndex]] = 
                [APP_STATE.questions[newIndex], APP_STATE.questions[action.index]];
                break;
        }
        
        // Remettre dans le passé
        HISTORY_STATE.past.push(action);
        
        // Rafraîchir l'affichage
        renderQuestionsList();
        updateHistoryButtons();
    }

    // ========================================
    // MISE À JOUR DES BOUTONS
    // ========================================
    
    function updateHistoryButtons() {
        const undoBtn = document.getElementById('undo-btn');
        const redoBtn = document.getElementById('redo-btn');
        
        if (undoBtn) {
            undoBtn.disabled = HISTORY_STATE.past.length === 0;
        }
        
        if (redoBtn) {
            redoBtn.disabled = HISTORY_STATE.future.length === 0;
        }
    }

    // ========================================
    // FONCTIONS PUBLIQUES POUR ENREGISTRER
    // ========================================
    
    function recordEdit(index, oldQuestion, newQuestion) {
        saveAction({
            type: 'edit',
            index: index,
            oldData: JSON.stringify(oldQuestion),
            newData: JSON.stringify(newQuestion)
        });
    }

    function recordDelete(index, question) {
        saveAction({
            type: 'delete',
            index: index,
            data: JSON.stringify(question)
        });
    }

    function recordMove(index, direction) {
        saveAction({
            type: 'move',
            index: index,
            direction: direction
        });
    }

    // ========================================
    // RÉINITIALISER L'HISTORIQUE
    // ========================================
    
    function clearHistory() {
        HISTORY_STATE.past = [];
        HISTORY_STATE.future = [];
        updateHistoryButtons();
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.undoAction = undoAction;
    window.redoAction = redoAction;
    window.recordEdit = recordEdit;
    window.recordDelete = recordDelete;
    window.recordMove = recordMove;
    window.clearHistory = clearHistory;
    window.updateHistoryButtons = updateHistoryButtons;

})();
