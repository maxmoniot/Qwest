// ============================================
// MODULE: MAIN
// Description: Point d'entrée principal de l'application
// ============================================

(function() {
    'use strict';

    // ========================================
    // INITIALISATION
    // ========================================
    
    function init() {
        console.log('🎯 Qwest - Initialisation...');
        
        // Vérifier que tous les modules sont chargés
        if (!window.CONFIG) {
            console.error('❌ Module config.js non chargé');
            return;
        }
        
        // Afficher la page d'accueil
        showPage('home-page');
        
        // Focus sur le champ de code
        const input = document.getElementById('quiz-code-input');
        if (input) {
            input.focus();
        }
        
        console.log('✅ Qwest initialisé');
    }

    // ========================================
    // GESTION DU RESPONSIVE
    // ========================================
    
    function handleResize() {
        // Gérer les ajustements responsive si nécessaire
        const width = window.innerWidth;
        
        if (width <= 768) {
            document.body.classList.add('mobile');
        } else {
            document.body.classList.remove('mobile');
        }
    }

    // ========================================
    // GESTION DES MODAUX
    // ========================================
    
    // Fermer les modaux en cliquant à l'extérieur
    window.addEventListener('click', function(e) {
        if (e.target.classList.contains('modal')) {
            // Déterminer quel modal est ouvert
            const modals = document.querySelectorAll('.modal.active');
            modals.forEach(modal => {
                // Ne pas fermer le modal de pilotage (control-modal) en cliquant à l'extérieur
                if (modal.id === 'control-modal') {
                    return;
                }
                
                // Ne fermer que si on clique sur le fond, pas sur le contenu
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        }
    });

    // ========================================
    // ÉVÉNEMENTS
    // ========================================
    
    window.addEventListener('load', function() {
        init();
        handleResize();
    });

    window.addEventListener('resize', handleResize);

    // Gérer la touche Échap pour fermer les modaux
    window.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const activeModals = document.querySelectorAll('.modal.active');
            activeModals.forEach(modal => {
                // Ne pas fermer le modal de pilotage avec Échap
                if (modal.id === 'control-modal') {
                    return;
                }
                modal.classList.remove('active');
            });
        }
    });

    // ========================================
    // PRÉVENTION DU RECHARGEMENT ACCIDENTEL
    // ========================================
    
    window.addEventListener('beforeunload', function(e) {
        // Vérifier si le panneau de pilotage est ouvert
        const controlModal = document.getElementById('control-modal');
        const isControlOpen = controlModal && controlModal.classList.contains('active');
        
        // Avertir UNIQUEMENT si :
        // 1. Panneau de pilotage ouvert (partie en cours), OU
        // 2. En édition active (ajout/modification de questions)
        if (isControlOpen || APP_STATE.isEditingQuestions) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.init = init;

})();
