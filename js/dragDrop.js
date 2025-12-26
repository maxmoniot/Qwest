// ============================================
// MODULE: DRAG AND DROP (Mobile)
// Description: Déplacement des questions par drag & drop sur mobile
// ============================================

(function() {
    'use strict';

    let dragState = {
        isDragging: false,
        draggedElement: null,
        draggedIndex: null,
        startY: 0,
        currentY: 0,
        placeholder: null,
        offsetY: 0
    };

    // ========================================
    // INITIALISATION DU DRAG & DROP
    // ========================================
    
    function initDragAndDrop() {
        // Seulement sur mobile (max-width: 768px)
        if (window.innerWidth > 768) return;
        
        const questionsList = document.getElementById('questions-list');
        if (!questionsList) return;
        
        // Utiliser la délégation d'événements
        questionsList.addEventListener('touchstart', handleTouchStart, { passive: false });
        questionsList.addEventListener('touchmove', handleTouchMove, { passive: false });
        questionsList.addEventListener('touchend', handleTouchEnd, { passive: false });
        questionsList.addEventListener('touchcancel', handleTouchEnd, { passive: false });
    }

    // ========================================
    // GESTION DU TOUCH START
    // ========================================
    
    function handleTouchStart(e) {
        // Vérifier qu'on touche bien une question-card-center
        const center = e.target.closest('.question-card-center');
        if (!center) return;
        
        // Ne pas démarrer le drag si on touche un lien ou bouton dans le center
        if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
        
        const card = center.closest('.question-card');
        if (!card) return;
        
        const index = parseInt(card.dataset.index);
        if (isNaN(index)) return;
        
        // Empêcher le scroll pendant le drag
        e.preventDefault();
        
        // Sauvegarder les dimensions et position avant de le retirer du flux
        const rect = card.getBoundingClientRect();
        
        // Initialiser le drag
        dragState.isDragging = true;
        dragState.draggedElement = card;
        dragState.draggedIndex = index;
        dragState.startY = e.touches[0].clientY;
        dragState.currentY = e.touches[0].clientY;
        dragState.offsetY = e.touches[0].clientY - rect.top;
        
        // Créer un placeholder AVANT de modifier l'élément
        createPlaceholder(card);
        
        // Remplacer l'élément par le placeholder dans le DOM
        card.parentNode.insertBefore(dragState.placeholder, card);
        
        // Mettre l'élément en position fixed pour qu'il suive le doigt
        card.style.position = 'fixed';
        card.style.width = rect.width + 'px';
        card.style.left = rect.left + 'px';
        card.style.top = rect.top + 'px';
        card.style.margin = '0';
        
        // Ajouter la classe de dragging
        card.classList.add('dragging');
    }

    // ========================================
    // GESTION DU TOUCH MOVE
    // ========================================
    
    function handleTouchMove(e) {
        if (!dragState.isDragging) return;
        
        e.preventDefault();
        
        const touch = e.touches[0];
        dragState.currentY = touch.clientY;
        
        // Déplacer l'élément pour suivre le doigt (position absolue par rapport au doigt)
        const newTop = touch.clientY - dragState.offsetY;
        dragState.draggedElement.style.top = newTop + 'px';
        
        // Trouver sur quelle question on survole
        const cards = Array.from(document.querySelectorAll('.question-card:not(.dragging)'));
        const placeholder = dragState.placeholder;
        let insertBeforeCard = null;
        
        for (let card of cards) {
            if (card === placeholder) continue;
            
            const rect = card.getBoundingClientRect();
            const middle = rect.top + rect.height / 2;
            
            if (touch.clientY < middle) {
                insertBeforeCard = card;
                break;
            }
        }
        
        // Déplacer le placeholder
        const questionsList = document.getElementById('questions-list');
        if (insertBeforeCard) {
            questionsList.insertBefore(placeholder, insertBeforeCard);
        } else {
            questionsList.appendChild(placeholder);
        }
    }

    // ========================================
    // GESTION DU TOUCH END
    // ========================================
    
    function handleTouchEnd(e) {
        if (!dragState.isDragging) return;
        
        e.preventDefault();
        
        const card = dragState.draggedElement;
        const placeholder = dragState.placeholder;
        
        // Remettre les styles normaux
        card.style.position = '';
        card.style.width = '';
        card.style.left = '';
        card.style.top = '';
        card.style.margin = '';
        card.classList.remove('dragging');
        
        // Calculer la nouvelle position basée sur le placeholder
        const allCards = Array.from(document.querySelectorAll('.question-card'));
        const placeholderIndex = allCards.indexOf(placeholder);
        
        // Remplacer le placeholder par l'élément réel
        placeholder.parentNode.insertBefore(card, placeholder);
        placeholder.remove();
        
        // Calculer la nouvelle position dans le tableau
        const newCardsOrder = Array.from(document.querySelectorAll('.question-card'));
        const newIndex = newCardsOrder.indexOf(card);
        const oldIndex = dragState.draggedIndex;
        
        // Réorganiser dans APP_STATE si changement
        if (newIndex !== oldIndex) {
            const question = APP_STATE.questions.splice(oldIndex, 1)[0];
            APP_STATE.questions.splice(newIndex, 0, question);
            
            // Marquer qu'on est en édition
            APP_STATE.isEditingQuestions = true;
            
            // Rafraîchir l'affichage
            renderQuestionsList();
        }
        
        // Réinitialiser l'état
        resetDragState();
    }

    // ========================================
    // HELPERS
    // ========================================
    
    function createPlaceholder(card) {
        const placeholder = document.createElement('div');
        placeholder.className = 'question-card-placeholder';
        placeholder.style.height = card.offsetHeight + 'px';
        placeholder.style.margin = window.getComputedStyle(card).margin;
        
        dragState.placeholder = placeholder;
        card.parentNode.insertBefore(placeholder, card.nextSibling);
    }
    
    function resetDragState() {
        dragState.isDragging = false;
        dragState.draggedElement = null;
        dragState.draggedIndex = null;
        dragState.startY = 0;
        dragState.currentY = 0;
        dragState.placeholder = null;
        dragState.offsetY = 0;
    }

    // ========================================
    // RÉINITIALISER SUR RESIZE
    // ========================================
    
    let resizeTimeout;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function() {
            // Réinitialiser si on passe au-dessus de 768px
            if (window.innerWidth > 768 && dragState.isDragging) {
                handleTouchEnd(new Event('touchend'));
            }
        }, 250);
    });

    // ========================================
    // INITIALISATION
    // ========================================
    
    // Initialiser au chargement
    window.addEventListener('load', initDragAndDrop);

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.initDragAndDrop = initDragAndDrop;

})();
