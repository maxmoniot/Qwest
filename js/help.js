// ============================================
// MODULE: HELP (Aide)
// Description: Gestion de la modal d'aide et téléchargement du format
// ============================================

(function() {
    'use strict';

    // ========================================
    // GESTION DE LA MODAL
    // ========================================
    
    function openHelpModal() {
        const modal = document.getElementById('help-modal');
        if (modal) {
            modal.classList.add('active');
        }
    }

    function closeHelpModal() {
        const modal = document.getElementById('help-modal');
        if (modal) {
            modal.classList.remove('active');
        }
    }

    // ========================================
    // GESTION DE LA MODAL REMERCIEMENTS
    // ========================================
    
    function openThanksModal() {
        const modal = document.getElementById('thanks-modal');
        if (modal) {
            modal.classList.add('active');
        }
    }

    function closeThanksModal() {
        const modal = document.getElementById('thanks-modal');
        if (modal) {
            modal.classList.remove('active');
        }
    }

    // ========================================
    // TÉLÉCHARGEMENT DU FICHIER FORMAT
    // ========================================
    
    async function downloadFormatFile() {
        try {
            // Charger le fichier depuis le serveur
            const response = await fetch('Documentation/FORMAT_QUESTIONNAIRE.md');
            
            if (!response.ok) {
                throw new Error('Fichier non trouvé');
            }
            
            const content = await response.text();
            
            // Créer un blob et télécharger
            const blob = new Blob([content], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'FORMAT_QUESTIONNAIRE.md';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            console.log('✅ Fichier de format téléchargé');
            
        } catch (error) {
            console.error('❌ Erreur téléchargement:', error);
            alert('Erreur lors du téléchargement du fichier. Vérifiez que le fichier existe dans le dossier Documentation/');
        }
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.openHelpModal = openHelpModal;
    window.closeHelpModal = closeHelpModal;
    window.openThanksModal = openThanksModal;
    window.closeThanksModal = closeThanksModal;
    window.downloadFormatFile = downloadFormatFile;

})();
