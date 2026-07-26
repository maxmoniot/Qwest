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

        // Reconnexion auto : si une partie était en cours dans CET onglet (l'élève a
        // rechargé / fait "retour" / pull-to-refresh), on le replace directement dans
        // la partie au lieu de l'éjecter vers l'accueil. Sinon, accueil normal.
        var hasSaved = false;
        try { hasSaved = !!sessionStorage.getItem('qwest_active_session'); } catch (e) {}

        if (hasSaved && typeof window.tryRejoinActiveSession === 'function') {
            window.tryRejoinActiveSession()
                .then(function(ok) { if (!ok) showHomePage(); })
                .catch(function() { showHomePage(); });
        } else {
            showHomePage();
        }

        console.log('✅ Qwest initialisé');
    }

    function showHomePage() {
        // Afficher la page d'accueil + focus sur le champ de code
        showPage('home-page');
        const input = document.getElementById('quiz-code-input');
        if (input) {
            input.focus();
        }
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
    
    // Init au plus tôt (DOMContentLoaded), PAS sur window 'load' : ce dernier attend
    // toutes les ressources, dont le CDN qrcodejs — un CDN lent au collège retardait
    // alors l'affichage de l'accueil et la reconnexion auto. Le CDN est désormais async,
    // donc DOMContentLoaded n'attend que les scripts locaux.
    function bootstrap() {
        init();
        handleResize();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }

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
