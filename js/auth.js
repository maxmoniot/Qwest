// ============================================
// MODULE: AUTHENTIFICATION
// Description: Gestion de l'authentification prof et accès élèves
// ============================================

(function() {
    'use strict';

    // ========================================
    // GESTION DU CODE D'ENTRÉE
    // ========================================
    
    async function handleCodeInput() {
        const input = document.getElementById('quiz-code-input');
        // Normalisation forte : trim + uppercase systématique. Le code est toujours
        // généré en majuscules côté prof (cf. generateCode() dans utils.js avec
        // alphabet 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'). Si l'élève tape en minuscules,
        // on remet en majuscules pour que :
        //  (a) l'affichage reste cohérent (le champ visuel est aussi en uppercase via CSS),
        //  (b) le filesystem OVH (potentiellement sensible à la casse) trouve toujours
        //      le bon fichier de session, sans dépendre du strtoupper côté PHP.
        const code = input.value.trim().toUpperCase();
        // Garder la valeur affichée cohérente aussi
        if (input.value !== code) input.value = code;

        if (!code) {
            input.classList.add('error-shake');
            setTimeout(() => input.classList.remove('error-shake'), 500);
            return;
        }

        // C'est un code de partie élève
        joinGameWithCode(code);
    }
    
    // ========================================
    // AFFICHER LE CHAMP MOT DE PASSE ENSEIGNANT
    // ========================================
    
    function showTeacherPassword(event) {
        event.preventDefault();
        const container = document.getElementById('teacher-password-container');
        const link = event.target;
        
        container.style.display = 'block';
        link.style.display = 'none';
        
        // Focus sur le champ de mot de passe
        const passwordInput = document.getElementById('teacher-password-input');
        if (passwordInput) {
            passwordInput.focus();
        }
    }
    
    // ========================================
    // CONNEXION ENSEIGNANT
    // ========================================
    
    async function checkTeacherPasswordInput() {
        const input = document.getElementById('teacher-password-input');
        const password = input.value;
        
        // Ne rien faire si le champ est vide
        if (!password) {
            return;
        }
        
        // Vérifier le mot de passe
        const isTeacher = await checkTeacherPassword(password);
        
        if (isTeacher) {
            // Mode professeur - connexion automatique
            APP_STATE.isTeacher = true;
            showPage('create-page');
            input.value = '';
            
            // Masquer le container de mot de passe et réafficher le lien
            document.getElementById('teacher-password-container').style.display = 'none';
            document.querySelector('.teacher-link').style.display = 'block';
        }
    }
    
    async function handleTeacherLogin() {
        const input = document.getElementById('teacher-password-input');
        const password = input.value.trim();
        
        if (!password) {
            input.classList.add('error-shake');
            setTimeout(() => input.classList.remove('error-shake'), 500);
            return;
        }
        
        const isTeacher = await checkTeacherPassword(password);
        
        if (isTeacher) {
            // Mode professeur
            APP_STATE.isTeacher = true;
            showPage('create-page');
            input.value = '';
        } else {
            // Mot de passe incorrect
            input.classList.add('error-shake');
            setTimeout(() => input.classList.remove('error-shake'), 500);
            
            const container = input.parentElement;
            const errorMsg = document.createElement('div');
            errorMsg.className = 'error-message';
            errorMsg.textContent = '❌ Mot de passe incorrect';
            errorMsg.style.marginTop = '10px';
            container.appendChild(errorMsg);
            
            setTimeout(() => {
                errorMsg.remove();
            }, 3000);
            
            input.value = '';
        }
    }
    
    // ========================================
    // GESTION TOUCHE ENTRÉE MOT DE PASSE
    // ========================================
    
    function handleTeacherPasswordEnter(event) {
        if (event.key === 'Enter') {
            handleTeacherLogin();
        }
    }

    // ========================================
    // REJOINDRE UNE PARTIE
    // ========================================
    
    // Normalise un code : retire TOUS les espaces (normaux, insécables, internes) et
    // met en MAJUSCULES → le code fonctionne quelle que soit la façon de le taper.
    function normalizeCode(raw) {
        return (raw || '').replace(/\s+/g, '').toUpperCase();
    }

    // Affiche un message sous le champ code (rouge + shake si erreur, neutre sinon).
    function showCodeMessage(input, text, isError) {
        if (!input) return;
        if (isError) {
            input.classList.add('error-shake');
            setTimeout(() => input.classList.remove('error-shake'), 500);
        }
        const container = input.parentElement;
        if (!container) return;
        const old = container.querySelector('.error-message');
        if (old) old.remove();
        const msg = document.createElement('div');
        msg.className = 'error-message';
        if (!isError) msg.style.color = '#555';
        msg.textContent = text;
        container.appendChild(msg);
        setTimeout(() => { if (msg && msg.parentElement) msg.remove(); }, 3000);
    }

    async function joinGameWithCode(rawCode) {
        const input = document.getElementById('quiz-code-input');
        const code = normalizeCode(rawCode);
        if (!code) {
            showCodeMessage(input, '❌ Entre un code', true);
            return;
        }

        // Un « code invalide » au 1er essai venait presque toujours d'un aléa
        // TRANSITOIRE (serveur occupé au démarrage de la classe quand 25 postes tapent
        // le code en même temps, réponse mise en cache, CDN lent…). On RÉESSAIE avant de
        // déclarer le code invalide → plus besoin de recharger la page. On n'affiche
        // « Code invalide » QUE si le serveur CONFIRME que le code n'existe pas.
        const MAX_TRIES = 4;
        for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
            try {
                const response = await fetch(
                    'php/api.php?action=check_game&code=' + encodeURIComponent(code),
                    { cache: 'no-store' }
                );
                if (!response.ok) throw new Error('HTTP ' + response.status); // 500/429 → retry
                const result = await response.json();

                if (result && result.success && result.exists === true) {
                    APP_STATE.currentPlayCode = code;
                    showStudentJoinPage(code, result.quizName, result.totalQuestions || 0);
                    return;
                }
                if (result && result.success === true && result.exists === false) {
                    // Le serveur CONFIRME : ce code n'existe pas → vrai « code invalide ».
                    showCodeMessage(input, '❌ Code invalide', true);
                    return;
                }
                // success:false (erreur serveur transitoire) → on retente.
                throw new Error('not-success');
            } catch (error) {
                console.warn('check_game tentative ' + attempt + ' échouée:', error.message);
                if (attempt < MAX_TRIES) {
                    showCodeMessage(input, '⏳ Vérification…', false);
                    await new Promise(r => setTimeout(r, attempt * 500)); // 0,5 / 1 / 1,5 s
                    continue;
                }
                // Échec après plusieurs tentatives → ce n'est PAS « code invalide »
                // (réseau/serveur). On invite à réessayer, sans recharger.
                showCodeMessage(input, '⚠️ Connexion lente — réessaie dans un instant', true);
            }
        }
    }

    // ========================================
    // GESTION DU TOUCHE ENTRÉE
    // ========================================
    
    function setupEnterKeyListener() {
        const input = document.getElementById('quiz-code-input');
        if (input) {
            input.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    handleCodeInput();
                }
            });
            
            // Focus automatique au chargement
            input.focus();
        }
    }

    // ========================================
    // INITIALISATION
    // ========================================
    
    function initAuthUI() {
        setupEnterKeyListener();

        // Pré-remplir et rejoindre automatiquement si ?code=XXXX dans l'URL
        // (utilisé par le QR code généré dans la popup de pilotage)
        const urlParams = new URLSearchParams(window.location.search);
        const codeParam = urlParams.get('code');
        if (codeParam) {
            const input = document.getElementById('quiz-code-input');
            if (input) {
                input.value = normalizeCode(codeParam);
                // Rejoindre automatiquement après un court délai (le temps que
                // l'interface soit initialisée)
                setTimeout(() => joinGameWithCode(codeParam), 300);
            }
        }
    }

    // Lier la touche Entrée DÈS QUE POSSIBLE — surtout PAS via window 'load', qui attend
    // aussi le script CDN qrcodejs : un CDN lent/filtré au collège retardait alors la
    // saisie du code (« il fallait recharger »). Les scripts étant en bas du <body>, le
    // champ code est déjà présent ici → on lie immédiatement, avec repli DOMContentLoaded.
    if (document.getElementById('quiz-code-input')) {
        initAuthUI();
    } else {
        document.addEventListener('DOMContentLoaded', initAuthUI);
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.handleCodeInput = handleCodeInput;
    window.joinGameWithCode = joinGameWithCode;
    window.showTeacherPassword = showTeacherPassword;
    window.checkTeacherPasswordInput = checkTeacherPasswordInput;
    window.handleTeacherLogin = handleTeacherLogin;
    window.handleTeacherPasswordEnter = handleTeacherPasswordEnter;

})();
