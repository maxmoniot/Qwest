// ============================================
// MODULE: SAUVEGARDE ET CHARGEMENT
// Description: Système de sauvegarde en ligne des questionnaires
// ============================================

(function() {
    'use strict';

    // Variables pour le captcha
    let captchaNum1, captchaNum2, captchaAnswer;

    // ========================================
    // CAPTCHA
    // ========================================
    
    function generateCaptcha() {
        captchaNum1 = Math.floor(Math.random() * 10) + 1;
        captchaNum2 = Math.floor(Math.random() * 10) + 1;
        captchaAnswer = captchaNum1 + captchaNum2;
        
        const element = document.getElementById('captcha-question');
        if (element) {
            element.textContent = `${captchaNum1} + ${captchaNum2} =`;
            console.log('Captcha généré:', { captchaNum1, captchaNum2, captchaAnswer });
        } else {
            console.error('Élément captcha-question non trouvé !');
        }
    }

    // ========================================
    // SAUVEGARDER UN QUESTIONNAIRE
    // ========================================
    
    function openSaveQuizModal() {
        // Vérifier qu'il y a au moins une question
        if (APP_STATE.questions.length === 0) {
            alert('⚠️ Vous devez créer au moins une question avant de sauvegarder.');
            return;
        }
        
        const modal = document.getElementById('save-quiz-modal');
        modal.classList.add('active');
        
        // Réinitialiser le formulaire
        document.getElementById('quiz-name-input').value = '';
        document.getElementById('captcha-answer-input').value = '';
        clearMessage('save-message');
        
        // Masquer le message de succès
        document.getElementById('save-success-display').style.display = 'none';
        
        // Réinitialiser le footer
        const footer = document.getElementById('save-modal-footer');
        footer.innerHTML = `
            <button class="btn-primary" onclick="confirmSaveQuiz()">💾 Sauvegarder en ligne</button>
            <button class="btn-secondary" onclick="exportQuizLocally()">📥 Exporter localement</button>
        `;
        
        // Générer le captcha
        generateCaptcha();
    }

    function closeSaveQuizModal() {
        document.getElementById('save-quiz-modal').classList.remove('active');
    }

    async function confirmSaveQuiz() {
        const nameInput = document.getElementById('quiz-name-input');
        const captchaInput = document.getElementById('captcha-answer-input');
        const quizName = nameInput.value.trim();
        const userAnswer = parseInt(captchaInput.value);
        
        // Validation du nom
        const validation = validateQuizName(quizName);
        if (!validation.valid) {
            showMessage('save-message', validation.error, 'error');
            return;
        }
        
        // Validation du captcha
        const userAnswerNum = parseInt(captchaInput.value);
        console.log('Captcha check:', { 
            userInput: captchaInput.value, 
            userAnswerNum, 
            captchaAnswer, 
            isNaN: isNaN(userAnswerNum),
            match: userAnswerNum === captchaAnswer 
        });
        
        if (isNaN(userAnswerNum) || userAnswerNum !== captchaAnswer) {
            showMessage('save-message', 'Captcha incorrect', 'error');
            generateCaptcha();
            captchaInput.value = '';
            captchaInput.focus();
            return;
        }
        
        // Vérifier qu'il y a des questions
        if (APP_STATE.questions.length === 0) {
            showMessage('save-message', 'Aucune question à sauvegarder', 'error');
            return;
        }
        
        // Afficher un message de chargement
        showMessage('save-message', 'Sauvegarde en cours...', 'info');
        
        try {
            // Préparer les données
            const quiz = new Quiz();
            quiz.name = quizName;
            quiz.questions = APP_STATE.questions;
            quiz.modifyCode = generateModifyCode();
            quiz.playCode = generatePlayCode();
            
            // Vérifier si le nom existe déjà
            const checkResponse = await fetch(`php/api.php?action=check_quiz&name=${encodeURIComponent(quizName)}`);
            const checkResult = await checkResponse.json();
            
            let modifyCode = quiz.modifyCode;
            
            if (checkResult.exists) {
                // Demander le code de modification
                const existingCode = prompt('⚠️ Ce nom est déjà utilisé !\n\nPour écraser cette sauvegarde, entrez le code de modification :\n\n(Annuler pour revenir)');
                
                if (!existingCode) {
                    showMessage('save-message', 'Sauvegarde annulée', 'warning');
                    return;
                }
                
                // Vérifier le code
                const verifyFormData = new FormData();
                verifyFormData.append('action', 'verify_modify_code');
                verifyFormData.append('quizName', quizName);
                verifyFormData.append('modifyCode', existingCode);
                
                const verifyResponse = await fetch('php/api.php', {
                    method: 'POST',
                    body: verifyFormData
                });
                
                const verifyResult = await verifyResponse.json();
                
                if (!verifyResult.success) {
                    showMessage('save-message', 'Code de modification incorrect', 'error');
                    return;
                }
                
                // Utiliser le code existant
                modifyCode = existingCode;
            }
            
            // Sauvegarder
            const formData = new FormData();
            formData.append('action', 'save_quiz');
            formData.append('quizName', quizName);
            formData.append('modifyCode', modifyCode);
            formData.append('playCode', quiz.playCode);
            formData.append('quizData', JSON.stringify(quiz));
            formData.append('captchaAnswer', userAnswer);
            formData.append('captchaExpected', captchaAnswer);
            
            const response = await fetch('php/api.php', {
                method: 'POST',
                body: formData
            });
            
            // Log de la réponse brute
            const responseText = await response.text();
            console.log('Réponse serveur brute:', responseText);
            
            let result;
            try {
                result = JSON.parse(responseText);
            } catch (parseError) {
                console.error('Erreur parsing JSON:', parseError);
                console.error('Texte reçu:', responseText.substring(0, 200));
                throw new Error('Réponse serveur invalide');
            }
            
            if (result.success) {
                // Succès !
                showMessage('save-message', result.message, 'success');
                
                // Sauvegarder dans l'état global (sans code play, il sera généré au pilotage)
                APP_STATE.currentModifyCode = modifyCode;
                APP_STATE.currentPlayCode = null; // Sera généré au pilotage
                
                // Afficher le code de modification
                document.getElementById('modify-code-display').value = modifyCode;
                
                // Afficher le message de succès et le bouton piloter
                document.getElementById('save-success-display').style.display = 'block';
                
                // Afficher le bouton dans le header
                updateHeaderButtons();
                
                // Masquer le footer
                const footer = document.getElementById('save-modal-footer');
                footer.innerHTML = '<button class="btn-primary" onclick="closeSaveQuizModal()" style="width: 100%;">Fermer</button>';
                
            } else {
                showMessage('save-message', result.message, 'error');
                generateCaptcha();
            }
            
        } catch (error) {
            console.error('Erreur sauvegarde:', error);
            showMessage('save-message', 'Erreur de connexion au serveur', 'error');
            generateCaptcha();
        }
    }

    // ========================================
    // CHARGER UN QUESTIONNAIRE
    // ========================================
    
    async function openLoadQuizModal() {
        const modal = document.getElementById('load-quiz-modal');
        modal.classList.add('active');
        
        clearMessage('load-message');
        
        // Charger la liste des questionnaires
        await loadQuizList();
    }

    function closeLoadQuizModal() {
        document.getElementById('load-quiz-modal').classList.remove('active');
    }

    async function loadQuizList() {
        const listDiv = document.getElementById('quiz-list');
        listDiv.innerHTML = '<div class="loading">Chargement...</div>';

        try {
            const response = await fetch('php/api.php?action=list_quizzes');
            const result = await response.json();

            if (result.success && result.quizzes && result.quizzes.length > 0) {
                listDiv.innerHTML = '';

                // Trier par nom alphabétique
                result.quizzes.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

                // Grouper par dossier virtuel (préfixe avant le premier "_")
                const groups = new Map();
                const ungrouped = [];
                result.quizzes.forEach(quiz => {
                    const idx = quiz.name.indexOf('_');
                    if (idx > 0) {
                        const folder = quiz.name.substring(0, idx);
                        if (!groups.has(folder)) groups.set(folder, []);
                        groups.get(folder).push(quiz);
                    } else {
                        ungrouped.push(quiz);
                    }
                });

                // Trier les noms de dossiers alphabétiquement
                const folderNames = Array.from(groups.keys()).sort((a, b) =>
                    a.localeCompare(b, 'fr', { sensitivity: 'base' })
                );

                folderNames.forEach(folder => {
                    const quizzes = groups.get(folder);
                    const folderDiv = document.createElement('div');
                    folderDiv.className = 'quiz-folder';

                    const header = document.createElement('div');
                    header.className = 'quiz-folder-header';
                    header.innerHTML = `
                        <span class="quiz-folder-toggle">▶</span>
                        <span class="quiz-folder-name">📁 ${folder}</span>
                        <span class="quiz-folder-count">${quizzes.length}</span>
                    `;

                    const content = document.createElement('div');
                    content.className = 'quiz-folder-content';
                    content.style.display = 'none';

                    quizzes.forEach(quiz => {
                        content.appendChild(buildQuizItem(quiz));
                    });

                    header.onclick = () => {
                        const open = folderDiv.classList.toggle('open');
                        content.style.display = open ? '' : 'none';
                    };

                    folderDiv.appendChild(header);
                    folderDiv.appendChild(content);
                    listDiv.appendChild(folderDiv);
                });

                // Quiz sans préfixe : affichés directement au niveau racine
                ungrouped.forEach(quiz => {
                    listDiv.appendChild(buildQuizItem(quiz));
                });

            } else {
                listDiv.innerHTML = '<div class="empty-list">Aucun questionnaire trouvé</div>';
            }

        } catch (error) {
            console.error('Erreur chargement liste:', error);
            listDiv.innerHTML = '<div class="error-list">❌ Erreur de chargement</div>';
        }
    }

    function buildQuizItem(quiz) {
        const quizDiv = document.createElement('div');
        quizDiv.className = 'quiz-item';
        quizDiv.style.cursor = 'pointer';
        quizDiv.innerHTML = `
            <div class="quiz-item-header">
                <h4>${quiz.name}</h4>
                <span class="quiz-count">${quiz.questionCount} questions</span>
            </div>
        `;
        quizDiv.onclick = () => loadQuizByName(quiz.name);
        return quizDiv;
    }

    function filterQuizList() {
        const searchValue = document.getElementById('search-quiz-input').value.toLowerCase();
        const items = document.querySelectorAll('#quiz-list .quiz-item');

        items.forEach(item => {
            const name = item.querySelector('h4').textContent.toLowerCase();
            item.style.display = name.includes(searchValue) ? '' : 'none';
        });

        // Pour chaque dossier : ouvrir si recherche active et au moins un enfant visible,
        // masquer le dossier si aucun enfant ne correspond
        document.querySelectorAll('#quiz-list .quiz-folder').forEach(folderDiv => {
            const content = folderDiv.querySelector('.quiz-folder-content');
            const visibleItems = content.querySelectorAll('.quiz-item:not([style*="display: none"])');
            const hasMatch = visibleItems.length > 0;

            if (searchValue === '') {
                // Recherche vide : restaurer l'état replié et tout afficher
                folderDiv.style.display = '';
                folderDiv.classList.remove('open');
                content.style.display = 'none';
            } else {
                folderDiv.style.display = hasMatch ? '' : 'none';
                if (hasMatch) {
                    folderDiv.classList.add('open');
                    content.style.display = '';
                }
            }
        });
    }

    async function loadQuizByName(quizName) {
        try {
            const response = await fetch(`php/api.php?action=load_quiz&name=${encodeURIComponent(quizName)}`);
            const result = await response.json();
            
            if (result.success && result.quiz) {
                // Charger les données
                APP_STATE.questions = result.quiz.questions || [];
                APP_STATE.currentPlayCode = result.quiz.playCode;
                APP_STATE.currentModifyCode = null; // On ne connaît pas le code de modif
                
                // IMPORTANT : On a chargé, pas édité
                APP_STATE.isEditingQuestions = false;
                
                // Fermer le modal
                closeLoadQuizModal();
                
                // Rafraîchir l'affichage
                renderQuestionsList();
                
                // Afficher les boutons dans le header
                updateHeaderButtons();
                
                // Afficher le code de partie et le bouton piloter
                showLoadedQuizActions(quizName, result.quiz.playCode);
                
            } else {
                showMessage('load-message', result.message, 'error');
            }
            
        } catch (error) {
            console.error('Erreur chargement quiz:', error);
            showMessage('load-message', 'Erreur de chargement', 'error');
        }
    }

    // Afficher les actions après chargement d'un quiz
    function showLoadedQuizActions(quizName, playCode) {
        // Créer un modal temporaire pour afficher le bouton piloter
        const existingModal = document.getElementById('loaded-quiz-actions-modal');
        if (existingModal) {
            existingModal.remove();
        }
        
        const modal = document.createElement('div');
        modal.id = 'loaded-quiz-actions-modal';
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>✅ Questionnaire chargé</h3>
                    <button class="close-btn" onclick="closeModal('loaded-quiz-actions-modal')">×</button>
                </div>
                <div class="modal-body">
                    <p><strong>${quizName}</strong> - ${APP_STATE.questions.length} questions</p>
                    
                    <div class="action-buttons" style="margin-top: 20px;">
                        <button class="btn-launch" onclick="closeModal('loaded-quiz-actions-modal'); openControlPanel();">
                            🚀 Piloter la partie
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
    }

    // ========================================
    // LANCER LA PARTIE (PILOTAGE)
    // ========================================
    
    function launchGameControl() {
        if (!APP_STATE.currentPlayCode) {
            alert('⚠️ Vous devez d\'abord sauvegarder le questionnaire.');
            return;
        }
        
        // Fermer le modal de sauvegarde
        closeSaveQuizModal();
        
        // Ouvrir le modal de pilotage
        // Cette fonction sera développée en Phase 3
        alert('🚧 Phase 3 : Pilotage de la partie en développement');
    }

    // Mettre à jour les boutons du header
    function updateHeaderButtons() {
        const pilotBtn = document.getElementById('pilot-btn');
        
        if (APP_STATE.questions.length > 0) {
            if (pilotBtn) pilotBtn.style.display = 'inline-block';
        } else {
            if (pilotBtn) pilotBtn.style.display = 'none';
        }
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.generateCaptcha = generateCaptcha;
    window.openSaveQuizModal = openSaveQuizModal;
    window.closeSaveQuizModal = closeSaveQuizModal;
    window.confirmSaveQuiz = confirmSaveQuiz;
    window.openLoadQuizModal = openLoadQuizModal;
    window.closeLoadQuizModal = closeLoadQuizModal;
    window.loadQuizList = loadQuizList;
    window.filterQuizList = filterQuizList;
    window.loadQuizByName = loadQuizByName;
    window.launchGameControl = launchGameControl;
    window.updateHeaderButtons = updateHeaderButtons;

})();
