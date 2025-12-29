// ============================================
// MODULE: UTILITAIRES
// Description: Fonctions utilitaires réutilisables
// ============================================

(function() {
    'use strict';

    // ========================================
    // HASH SHA-256 (identique à P-Blocks)
    // ========================================
    
    // Fonction pour hasher un mot de passe avec SHA-256
    async function hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    // Vérifier le hash du mot de passe prof (asynchrone)
    async function checkTeacherPassword(input) {
        const passwordHash = await hashPassword(input);
        return passwordHash === CONFIG.TEACHER_PASSWORD_HASH;
    }

    // ========================================
    // GÉNÉRATION DE CODES
    // ========================================
    
    // Générer un code aléatoire (comme dans P-Blocks)
    function generateCode(length = 8) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sans O, 0, I, 1
        let code = '';
        for (let i = 0; i < length; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    // Générer un code de modification (8 caractères)
    function generateModifyCode() {
        return generateCode(8);
    }

    // Générer un code de partie (6 caractères - plus court pour les élèves)
    function generatePlayCode() {
        return generateCode(6);
    }

    // ========================================
    // GESTION DES PAGES
    // ========================================
    
    function showPage(pageId) {
        // Masquer toutes les pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.remove('active');
        });
        
        // Afficher la page demandée
        const targetPage = document.getElementById(pageId);
        if (targetPage) {
            targetPage.classList.add('active');
            APP_STATE.currentPage = pageId;
        }
    }

    // ========================================
    // COPIE DANS LE PRESSE-PAPIER
    // ========================================
    
    function copyToClipboard(text, sourceElement) {
        // Créer un élément temporaire
        const temp = document.createElement('textarea');
        temp.value = text;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        
        // Sélectionner et copier
        temp.select();
        temp.setSelectionRange(0, 99999); // Pour mobile
        
        try {
            document.execCommand('copy');
            
            // Feedback visuel
            if (sourceElement) {
                const originalBg = sourceElement.style.backgroundColor;
                const originalTransition = sourceElement.style.transition;
                
                // Animation flash vert
                sourceElement.style.transition = 'background-color 0.3s ease';
                sourceElement.style.backgroundColor = '#4CAF50';
                
                // Afficher "✓ Copié !"
                const originalText = sourceElement.innerHTML;
                sourceElement.innerHTML = '✓ Copié !';
                
                // Retour à la normale après 1 seconde
                setTimeout(() => {
                    sourceElement.style.backgroundColor = originalBg;
                    sourceElement.innerHTML = originalText;
                    setTimeout(() => {
                        sourceElement.style.transition = originalTransition;
                    }, 300);
                }, 1000);
            }
            
            return true;
        } catch (err) {
            return false;
        } finally {
            document.body.removeChild(temp);
        }
    }

    // Copier un code et afficher un feedback
    function copyCode(inputId) {
        const input = document.getElementById(inputId);
        if (!input) return;
        
        const success = copyToClipboard(input.value);
        
        // Feedback visuel sur le bouton
        const button = event.target;
        const originalText = button.textContent;
        
        if (success) {
            button.textContent = '✅ Copié !';
            button.style.background = '#4CAF50';
        } else {
            button.textContent = '❌ Erreur';
            button.style.background = '#f44336';
        }
        
        setTimeout(() => {
            button.textContent = originalText;
            button.style.background = '';
        }, 2000);
    }

    // ========================================
    // MESSAGES ET NOTIFICATIONS
    // ========================================
    
    function showMessage(containerId, message, type = 'info') {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        let icon = 'ℹ️';
        let className = 'message-info';
        
        switch(type) {
            case 'success':
                icon = '✅';
                className = 'message-success';
                break;
            case 'error':
                icon = '❌';
                className = 'message-error';
                break;
            case 'warning':
                icon = '⚠️';
                className = 'message-warning';
                break;
        }
        
        container.innerHTML = `<div class="${className}">${icon} ${message}</div>`;
    }

    function clearMessage(containerId) {
        const container = document.getElementById(containerId);
        if (container) {
            container.innerHTML = '';
        }
    }

    // ========================================
    // CONFIRMATION PERSONNALISÉE
    // ========================================
    
    async function customConfirm(message) {
        return new Promise((resolve) => {
            const confirmed = confirm(message);
            resolve(confirmed);
        });
    }

    // ========================================
    // VALIDATION D'ENTRÉE
    // ========================================
    
    function sanitizeInput(input) {
        if (!input || typeof input !== 'string') return '';
        
        // Supprimer les balises HTML
        const div = document.createElement('div');
        div.textContent = input;
        return div.innerHTML.trim();
    }

    function validateQuizName(name) {
        if (!name || name.trim().length === 0) {
            return { valid: false, error: 'Le nom ne peut pas être vide' };
        }
        
        if (name.length > CONFIG.MAX_QUIZ_NAME_LENGTH) {
            return { valid: false, error: `Le nom ne peut pas dépasser ${CONFIG.MAX_QUIZ_NAME_LENGTH} caractères` };
        }
        
        // Vérifier les mots interdits
        if (window.PROFANITY_FILTER && !window.PROFANITY_FILTER.isClean(name)) {
            return { valid: false, error: window.PROFANITY_FILTER.getErrorMessage(name) };
        }
        
        return { valid: true };
    }

    // ========================================
    // FORMATAGE
    // ========================================
    
    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`;
    }

    function formatDate(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        // Moins d'une heure
        if (diff < 3600000) {
            const mins = Math.floor(diff / 60000);
            return `Il y a ${mins} min`;
        }
        
        // Moins d'un jour
        if (diff < 86400000) {
            const hours = Math.floor(diff / 3600000);
            return `Il y a ${hours}h`;
        }
        
        // Format date normale
        return date.toLocaleDateString('fr-FR', { 
            day: 'numeric', 
            month: 'short',
            year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
        });
    }

    // Fermer un modal par son ID
    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
            // Si c'est un modal temporaire, le supprimer
            if (modal.id.includes('display-modal') || modal.id.includes('actions-modal')) {
                setTimeout(() => modal.remove(), 300);
            }
        }
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.hashPassword = hashPassword;
    window.checkTeacherPassword = checkTeacherPassword;
    window.generateCode = generateCode;
    window.generateModifyCode = generateModifyCode;
    window.generatePlayCode = generatePlayCode;
    window.showPage = showPage;
    window.copyToClipboard = copyToClipboard;
    window.copyCode = copyCode;
    window.showMessage = showMessage;
    window.clearMessage = clearMessage;
    window.customConfirm = customConfirm;
    window.sanitizeInput = sanitizeInput;
    window.validateQuizName = validateQuizName;
    window.formatTime = formatTime;
    window.formatDate = formatDate;
    window.closeModal = closeModal;

})();
