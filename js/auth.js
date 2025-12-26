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
        const code = input.value.trim();
        
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
    
    async function joinGameWithCode(code) {
        const input = document.getElementById('quiz-code-input');
        
        try {
            // Vérifier que le code existe
            const response = await fetch(`php/api.php?action=check_game&code=${code}`);
            const result = await response.json();
            
            if (result.success && result.exists) {
                // Le code existe, passer à la page de sélection collège/pseudo
                APP_STATE.currentPlayCode = code;
                showStudentJoinPage(code, result.quizName, result.totalQuestions || 0);
            } else {
                // Code invalide
                input.classList.add('error-shake');
                setTimeout(() => input.classList.remove('error-shake'), 500);
                
                // Message d'erreur temporaire
                const container = input.parentElement;
                const errorMsg = document.createElement('div');
                errorMsg.className = 'error-message';
                errorMsg.textContent = '❌ Code invalide';
                container.appendChild(errorMsg);
                
                setTimeout(() => {
                    errorMsg.remove();
                }, 3000);
            }
        } catch (error) {
            console.error('Erreur lors de la vérification du code:', error);
            input.classList.add('error-shake');
            setTimeout(() => input.classList.remove('error-shake'), 500);
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
    
    window.addEventListener('load', function() {
        setupEnterKeyListener();
    });

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
