// ============================================
// MODULE: UTILITAIRES
// Description: Fonctions utilitaires réutilisables
// ============================================

(function() {
    'use strict';

    // ========================================
    // HASH SHA-256 (identique à P-Blocks)
    // ========================================
    
    // Repli SHA-256 en JS PUR (vérifié identique à crypto.subtle, y compris UTF-8).
    // INDISPENSABLE : crypto.subtle n'existe QUE dans un contexte sécurisé (HTTPS ou
    // localhost). Si le site est ouvert en HTTP simple (ex : lien/portail du collège en
    // http://), crypto.subtle est undefined → l'ancien hashPassword plantait → le login
    // prof ne faisait RIEN (clic sans effet). Avec ce repli, le login marche partout.
    function _sha256Bytes(bytes) {
        var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
        var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
        var l = bytes.length, bitLen = l * 8, withOne = l + 1, k = (56 - (withOne % 64) + 64) % 64, total = withOne + k + 8;
        var m = new Uint8Array(total); m.set(bytes); m[l] = 0x80;
        var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
        m[total-8]=(hi>>>24)&0xff;m[total-7]=(hi>>>16)&0xff;m[total-6]=(hi>>>8)&0xff;m[total-5]=hi&0xff;
        m[total-4]=(lo>>>24)&0xff;m[total-3]=(lo>>>16)&0xff;m[total-2]=(lo>>>8)&0xff;m[total-1]=lo&0xff;
        function rotr(x,n){ return (x>>>n)|(x<<(32-n)); }
        var w = new Array(64);
        for (var off = 0; off < total; off += 64) {
            for (var i=0;i<16;i++){ w[i]=(m[off+i*4]<<24)|(m[off+i*4+1]<<16)|(m[off+i*4+2]<<8)|(m[off+i*4+3]); }
            for (var i=16;i<64;i++){
                var s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
                var s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
                w[i]=(w[i-16]+s0+w[i-7]+s1)|0;
            }
            var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
            for (var i=0;i<64;i++){
                var S1=rotr(e,6)^rotr(e,11)^rotr(e,25), ch=(e&f)^((~e)&g), t1=(h+S1+ch+K[i]+w[i])|0;
                var S0=rotr(a,2)^rotr(a,13)^rotr(a,22), maj=(a&b)^(a&c)^(b&c), t2=(S0+maj)|0;
                h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
            }
            H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;
            H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
        }
        var hex=''; for (var i=0;i<8;i++){ hex += ('00000000'+(H[i]>>>0).toString(16)).slice(-8); }
        return hex;
    }

    // Fonction pour hasher un mot de passe avec SHA-256.
    // Utilise crypto.subtle si DISPONIBLE (contexte sécurisé HTTPS/localhost), sinon
    // repli JS pur (TextEncoder marche, lui, partout) → le login fonctionne aussi en HTTP.
    async function hashPassword(password) {
        const data = new TextEncoder().encode(password);
        try {
            if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
            }
        } catch (e) { /* contexte non sécurisé ou API indisponible → repli ci-dessous */ }
        return _sha256Bytes(data);
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

    /**
     * Échappe les caractères dangereux pour l'insertion dans du HTML.
     * À utiliser systématiquement pour interpoler dans des template literals
     * qui finissent dans innerHTML quand la valeur vient d'un utilisateur
     * (notamment player.nickname). Le serveur valide aussi côté joinGame, mais
     * l'escape côté client est une défense en profondeur.
     */
    function escapeHtml(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
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
    window.escapeHtml = escapeHtml;
    window.validateQuizName = validateQuizName;
    window.formatTime = formatTime;
    window.formatDate = formatDate;
    window.closeModal = closeModal;

})();
