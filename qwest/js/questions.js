// ============================================
// MODULE: GESTION DES QUESTIONS
// Description: Création, édition, suppression de questions
// ============================================

(function() {
    'use strict';

    // ========================================
    // AJOUTER UNE QUESTION
    // ========================================
    
    function addQuestion() {
        // Vérifier la limite
        if (APP_STATE.questions.length >= CONFIG.MAX_QUESTIONS) {
            alert(`⚠️ Vous avez atteint la limite de ${CONFIG.MAX_QUESTIONS} questions.`);
            return;
        }
        
        // Ouvrir le modal de sélection du type
        document.getElementById('add-question-modal').classList.add('active');
    }

    function closeAddQuestionModal() {
        document.getElementById('add-question-modal').classList.remove('active');
    }

    function createQuestion(type) {
        closeAddQuestionModal();
        
        // Créer une nouvelle question
        const question = new Question(type);
        question._isNew = true; // Marquer comme nouvelle question
        APP_STATE.questions.push(question);
        
        // Marquer qu'on est en édition active
        APP_STATE.isEditingQuestions = true;
        
        // Rafraîchir l'affichage
        renderQuestionsList();
        
        // Ouvrir directement l'éditeur pour cette question
        editQuestion(APP_STATE.questions.length - 1);
    }

    // ========================================
    // AFFICHAGE DE LA LISTE
    // ========================================
    
    function renderQuestionsList() {
        const container = document.getElementById('questions-list');
        const count = document.getElementById('question-count');
        
        // Mettre à jour le compteur
        count.textContent = APP_STATE.questions.length;
        
        // Mettre à jour les boutons du header (notamment le bouton Piloter)
        if (typeof updateHeaderButtons === 'function') {
            updateHeaderButtons();
        }
        
        // Si aucune question, afficher l'état vide
        if (APP_STATE.questions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <p>📋 Aucune question pour le moment</p>
                    <p>Cliquez sur "Ajouter une question" pour commencer</p>
                </div>
            `;
            return;
        }
        
        // Construire la liste
        let html = '';
        APP_STATE.questions.forEach((question, index) => {
            html += createQuestionCard(question, index);
        });
        
        container.innerHTML = html;
        
        // Réinitialiser le drag & drop mobile
        if (typeof initDragAndDrop === 'function') {
            setTimeout(initDragAndDrop, 0);
        }
    }

    function createQuestionCard(question, index) {
        const typeLabels = {
            'multiple': '☑️ Choix multiple',
            'truefalse': '✓✗ Vrai / Faux',
            'order': '🔢 Ordre',
            'freetext': '✍️ Réponse libre'
        };
        
        const questionText = question.question || '<em>Question non renseignée</em>';
        const correctCount = question.type === 'order' ? 
            question.answers.length : 
            question.answers.filter(a => a.correct).length;
        
        // Stats selon le type
        let statsText = '';
        if (question.type === 'order') {
            statsText = `${question.answers.length} éléments`;
        } else if (question.type === 'freetext') {
            const altCount = question.acceptedAnswers ? question.acceptedAnswers.length : 0;
            statsText = altCount > 0 ? `1 réponse + ${altCount} variante(s)` : '1 réponse attendue';
        } else {
            statsText = `${correctCount} bonne(s) réponse(s)`;
        }
        
        return `
            <div class="question-card" data-index="${index}">
                <div class="question-card-left">
                    <button class="btn-move-up" onclick="moveQuestion(${index}, -1)" 
                            ${index === 0 ? 'disabled' : ''}>
                        ⬆️
                    </button>
                    <button class="btn-move-down" onclick="moveQuestion(${index}, 1)"
                            ${index === APP_STATE.questions.length - 1 ? 'disabled' : ''}>
                        ⬇️
                    </button>
                </div>
                
                <div class="question-card-center">
                    <div class="question-info">
                        <span class="question-number">#${index + 1}</span>
                        <span class="question-type">${typeLabels[question.type]}</span>
                        <span class="question-time">⏱️ ${question.time}s</span>
                    </div>
                    <div class="question-content-row">
                        <div class="question-text-wrapper">
                            <div class="question-text">${questionText}</div>
                            <div class="question-stats">
                                ${statsText}
                            </div>
                        </div>
                        ${question.imageUrl ? `
                            <div class="question-card-image">
                                <img src="${question.imageUrl}" alt="Image de la question">
                            </div>
                        ` : ''}
                    </div>
                </div>
                
                <div class="question-card-right">
                    <button class="btn-action btn-edit" onclick="editQuestion(${index})">
                        ✏️ Éditer
                    </button>
                    <button class="btn-action btn-delete" onclick="deleteQuestion(${index})">
                        🗑️ Supprimer
                    </button>
                </div>
            </div>
        `;
    }

    // ========================================
    // ÉDITION D'UNE QUESTION
    // ========================================
    
    function editQuestion(index) {
        const question = APP_STATE.questions[index];
        if (!question) return;
        
        APP_STATE.editingQuestionIndex = index;
        
        // Sauvegarder l'état initial pour pouvoir restaurer si on annule
        APP_STATE.editingQuestionBackup = JSON.parse(JSON.stringify(question));
        
        const modal = document.getElementById('edit-question-modal');
        const title = document.getElementById('edit-modal-title');
        const content = document.getElementById('edit-question-content');
        
        title.textContent = `✏️ Éditer la question #${index + 1}`;
        
        // Générer le formulaire selon le type
        let formHTML = `
            <div class="form-group">
                <label>Image et temps :</label>
                <div class="image-time-row">
                    <button type="button" class="btn-add-image" onclick="openImageGalleryForQuestion()">
                        🖼️ Ajouter un visuel
                    </button>
                    <div class="time-input-inline">
                        <label>Durée d'affichage&nbsp;:</label>
                        <input type="number" 
                               id="edit-question-time" 
                               value="${question.time}"
                               min="${CONFIG.MIN_TIME}"
                               max="${CONFIG.MAX_TIME}">
                        <span>secondes</span>
                    </div>
                </div>
                <div id="question-image-container">
                    ${question.imageUrl ? `
                        <div class="question-image-preview">
                            <img src="${question.imageUrl}" alt="Image de la question">
                            <button type="button" class="btn-remove-image" onclick="removeQuestionImage()" title="Supprimer l'image">
                                ✕
                            </button>
                        </div>
                    ` : ''}
                </div>
            </div>
            
            <div class="form-group">
                <label>Question :</label>
                <textarea id="edit-question-text" 
                          placeholder="Votre question..."
                          rows="3">${question.question}</textarea>
            </div>
            
            <div class="form-group">
                <label>Réponses :</label>
        `;
        
        // Ajouter les champs de réponses selon le type
        switch(question.type) {
            case QUESTION_TYPES.MULTIPLE:
                formHTML += renderMultipleChoiceEditor(question);
                break;
            case QUESTION_TYPES.TRUEFALSE:
                formHTML += renderTrueFalseEditor(question);
                break;
            case QUESTION_TYPES.ORDER:
                formHTML += renderOrderEditor(question);
                break;
            case QUESTION_TYPES.FREETEXT:
                formHTML += renderFreeTextEditor(question);
                break;
        }
        
        formHTML += '</div>';
        content.innerHTML = formHTML;
        
        // Afficher le modal
        modal.classList.add('active');
        
        // Réinitialiser le scroll en haut
        const modalBody = modal.querySelector('.modal-body');
        if (modalBody) {
            modalBody.scrollTop = 0;
        }
    }

    function renderMultipleChoiceEditor(question) {
        let html = '<div class="answers-editor">';
        
        question.answers.forEach((answer, index) => {
            html += `
                <div class="answer-row">
                    <div class="answer-checkbox">
                        <input type="radio" 
                               name="correct-answer"
                               id="answer-${index}" 
                               value="${index}"
                               ${answer.correct ? 'checked' : ''}>
                        <label for="answer-${index}">Correcte</label>
                    </div>
                    <input type="text" 
                           class="answer-input" 
                           data-index="${index}"
                           placeholder="Réponse ${index + 1}..."
                           value="${answer.text}">
                </div>
            `;
        });
        
        html += '</div>';
        return html;
    }

    function renderTrueFalseEditor(question) {
        return `
            <div class="answers-editor">
                <div class="answer-row">
                    <label>
                        <input type="radio" 
                               name="truefalse" 
                               value="0"
                               ${question.answers[0].correct ? 'checked' : ''}>
                        La bonne réponse est : <strong>Vrai</strong>
                    </label>
                </div>
                <div class="answer-row">
                    <label>
                        <input type="radio" 
                               name="truefalse" 
                               value="1"
                               ${question.answers[1].correct ? 'checked' : ''}>
                        La bonne réponse est : <strong>Faux</strong>
                    </label>
                </div>
            </div>
        `;
    }

    function renderOrderEditor(question) {
        let html = '<div class="answers-editor order-editor">';
        html += '<p class="info-text">📝 Entrez les éléments dans le bon ordre (du premier au dernier)</p>';
        
        question.answers.forEach((answer, index) => {
            html += `
                <div class="answer-row">
                    <span class="order-number">${index + 1}.</span>
                    <input type="text" 
                           class="answer-input" 
                           data-index="${index}"
                           placeholder="Élément ${index + 1}..."
                           value="${answer.text}">
                </div>
            `;
        });
        
        html += `
            <div class="order-actions">
                <button class="btn-small" onclick="addOrderItem()">➕ Ajouter un élément</button>
                ${question.answers.length > 2 ? 
                    '<button class="btn-small btn-danger" onclick="removeOrderItem()">➖ Retirer le dernier</button>' : 
                    ''
                }
            </div>
        `;
        
        html += '</div>';
        return html;
    }

    function closeEditQuestionModal() {
        const index = APP_STATE.editingQuestionIndex;
        
        // Si c'est une nouvelle question qui n'a jamais été sauvegardée, la supprimer
        if (index !== null && APP_STATE.questions[index] && APP_STATE.questions[index]._isNew) {
            // Vérifier si la question est vide (pas de texte de question)
            const question = APP_STATE.questions[index];
            if (!question.question || question.question.trim() === '') {
                // Supprimer la question vide
                APP_STATE.questions.splice(index, 1);
                // Rafraîchir l'affichage
                renderQuestionsList();
            }
        }
        // Si on avait une sauvegarde, restaurer l'état initial (car on n'a pas enregistré)
        // Mais seulement si le backup existe encore (il est nettoyé après un enregistrement)
        else if (index !== null && APP_STATE.editingQuestionBackup) {
            APP_STATE.questions[index] = APP_STATE.editingQuestionBackup;
            // Rafraîchir l'affichage pour montrer l'annulation
            renderQuestionsList();
        }
        
        document.getElementById('edit-question-modal').classList.remove('active');
        APP_STATE.editingQuestionIndex = null;
        APP_STATE.editingQuestionBackup = null;
    }

    function saveEditedQuestion() {
        const index = APP_STATE.editingQuestionIndex;
        if (index === null) return;
        
        const question = APP_STATE.questions[index];
        
        // Sauvegarder l'état AVANT modification pour l'historique (c'est le backup qu'on a fait à l'ouverture)
        const oldQuestion = APP_STATE.editingQuestionBackup;
        
        // Récupérer les valeurs
        question.question = document.getElementById('edit-question-text').value.trim();
        question.time = parseInt(document.getElementById('edit-question-time').value) || CONFIG.DEFAULT_TIME;
        
        // Sauvegarder les réponses selon le type
        switch(question.type) {
            case QUESTION_TYPES.MULTIPLE:
                saveMultipleChoiceAnswers(question);
                break;
            case QUESTION_TYPES.TRUEFALSE:
                saveTrueFalseAnswers(question);
                break;
            case QUESTION_TYPES.ORDER:
                saveOrderAnswers(question);
                break;
            case QUESTION_TYPES.FREETEXT:
                saveFreeTextAnswers(question);
                break;
        }
        
        // Retirer le flag _isNew car la question a été sauvegardée
        delete question._isNew;
        
        // Enregistrer dans l'historique
        const newQuestion = JSON.parse(JSON.stringify(question));
        if (typeof recordEdit === 'function') {
            recordEdit(index, oldQuestion, newQuestion);
        }
        
        // Nettoyer la sauvegarde AVANT de fermer (pour éviter la restauration)
        APP_STATE.editingQuestionBackup = null;
        
        // Fermer le modal (sans restauration car backup est null)
        document.getElementById('edit-question-modal').classList.remove('active');
        APP_STATE.editingQuestionIndex = null;
        
        // Rafraîchir l'affichage
        renderQuestionsList();
    }

    function saveMultipleChoiceAnswers(question) {
        const inputs = document.querySelectorAll('.answer-input');
        const selectedRadio = document.querySelector('input[name="correct-answer"]:checked');
        const correctIndex = selectedRadio ? parseInt(selectedRadio.value) : 0;
        
        inputs.forEach((input, index) => {
            if (question.answers[index]) {
                question.answers[index].text = input.value.trim();
                question.answers[index].correct = (index === correctIndex);
            }
        });
    }

    function saveTrueFalseAnswers(question) {
        const selected = document.querySelector('input[name="truefalse"]:checked');
        if (selected) {
            const index = parseInt(selected.value);
            question.answers[0].correct = (index === 0);
            question.answers[1].correct = (index === 1);
        }
    }

    function saveOrderAnswers(question) {
        const inputs = document.querySelectorAll('.answer-input');
        const newAnswers = [];
        
        inputs.forEach((input, index) => {
            const text = input.value.trim();
            if (text) {
                newAnswers.push({ text: text, order: index + 1 });
            }
        });
        
        question.answers = newAnswers;
    }

    // ========================================
    // GESTION DE L'ORDRE
    // ========================================
    
    function moveQuestion(index, direction) {
        const newIndex = index + direction;
        
        if (newIndex < 0 || newIndex >= APP_STATE.questions.length) {
            return;
        }
        
        // Enregistrer dans l'historique AVANT le déplacement
        if (typeof recordMove === 'function') {
            recordMove(index, direction);
        }
        
        // FLIP Animation - Étape 1: First (sauvegarder les positions AVANT)
        const cards = Array.from(document.querySelectorAll('.question-card'));
        const firstPositions = {};
        
        cards.forEach(card => {
            const cardIndex = parseInt(card.dataset.index);
            const rect = card.getBoundingClientRect();
            firstPositions[cardIndex] = {
                top: rect.top,
                left: rect.left
            };
        });
        
        // Échanger dans le state
        [APP_STATE.questions[index], APP_STATE.questions[newIndex]] = 
        [APP_STATE.questions[newIndex], APP_STATE.questions[index]];
        
        // Désactiver temporairement l'initialisation du drag & drop
        const tempInitDragAndDrop = window.initDragAndDrop;
        window.initDragAndDrop = function() {};
        
        // FLIP Animation - Étape 2: Last (laisser le DOM se réorganiser)
        renderQuestionsList();
        
        // Restaurer initDragAndDrop
        window.initDragAndDrop = tempInitDragAndDrop;
        
        // FLIP Animation - Étape 3 & 4: Invert & Play
        requestAnimationFrame(() => {
            const newCards = Array.from(document.querySelectorAll('.question-card'));
            
            newCards.forEach(card => {
                const cardIndex = parseInt(card.dataset.index);
                
                // Récupérer l'ancienne position de cette question
                // Attention: après l'échange, l'index a changé
                let oldIndex = cardIndex;
                
                // Si c'est la question qui était à 'index', elle est maintenant à 'newIndex'
                if (cardIndex === newIndex) {
                    oldIndex = index;
                } else if (cardIndex === index) {
                    oldIndex = newIndex;
                }
                
                const firstPos = firstPositions[oldIndex];
                if (!firstPos) return;
                
                const lastPos = card.getBoundingClientRect();
                
                // Calculer le delta
                const deltaX = firstPos.left - lastPos.left;
                const deltaY = firstPos.top - lastPos.top;
                
                // Si la card n'a pas bougé, ne rien faire
                if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
                
                // Invert: appliquer le transform inverse immédiatement (sans transition)
                card.style.transition = 'none';
                card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
                
                // Forcer un reflow
                card.offsetHeight;
                
                // Play: animer vers la position finale
                card.style.transition = 'transform 0.4s cubic-bezier(0.4, 0.0, 0.2, 1)';
                card.style.transform = 'translate(0, 0)';
                
                // Nettoyer après l'animation
                const cleanup = () => {
                    card.style.transition = '';
                    card.style.transform = '';
                    card.removeEventListener('transitionend', cleanup);
                };
                card.addEventListener('transitionend', cleanup);
            });
            
            // Réinitialiser le drag & drop après l'animation
            setTimeout(() => {
                if (typeof tempInitDragAndDrop === 'function') {
                    tempInitDragAndDrop();
                }
            }, 450);
        });
    }

    function deleteQuestion(index) {
        // Sauvegarder pour l'historique
        const deletedQuestion = JSON.parse(JSON.stringify(APP_STATE.questions[index]));
        
        // Supprimer
        APP_STATE.questions.splice(index, 1);
        
        // Enregistrer dans l'historique
        if (typeof recordDelete === 'function') {
            recordDelete(index, deletedQuestion);
        }
        
        renderQuestionsList();
    }

    // ========================================
    // GESTION DU TEMPS
    // ========================================
    
    function updateAllQuestionTimes() {
        // Cette fonction est appelée quand on change la valeur par défaut
        const defaultTime = parseInt(document.getElementById('default-time').value);
        CONFIG.DEFAULT_TIME = defaultTime;
    }

    function applyTimeToAll() {
        const time = parseInt(document.getElementById('default-time').value);
        
        if (confirm(`Appliquer ${time} secondes à toutes les questions ?`)) {
            APP_STATE.questions.forEach(question => {
                question.time = time;
            });
            renderQuestionsList();
        }
    }

    // ========================================
    // GESTION ÉLÉMENTS ORDRE
    // ========================================
    
    function addOrderItem() {
        const index = APP_STATE.editingQuestionIndex;
        if (index === null) return;
        
        const question = APP_STATE.questions[index];
        const newOrder = question.answers.length + 1;
        
        question.answers.push({ text: '', order: newOrder });
        
        // Re-rendre l'éditeur
        editQuestion(index);
    }

    function removeOrderItem() {
        const index = APP_STATE.editingQuestionIndex;
        if (index === null) return;
        
        const question = APP_STATE.questions[index];
        
        if (question.answers.length > 2) {
            question.answers.pop();
            editQuestion(index);
        }
    }

    // ========================================
    // GESTION DES IMAGES
    // ========================================
    
    function openImageGalleryForQuestion() {
        // Ouvrir la galerie avec callback
        if (typeof openImageGallery === 'function') {
            openImageGallery(function(imageUrl) {
                // Callback appelé quand une image est sélectionnée
                setQuestionImage(imageUrl);
            });
        }
    }
    
    function setQuestionImage(imageUrl) {
        const index = APP_STATE.editingQuestionIndex;
        if (index === null) return;
        
        const question = APP_STATE.questions[index];
        
        // Ajouter l'image
        question.imageUrl = imageUrl;
        
        // Mettre à jour l'aperçu
        const container = document.getElementById('question-image-container');
        if (container) {
            container.innerHTML = `
                <div class="question-image-preview">
                    <img src="${imageUrl}" alt="Image de la question">
                    <button type="button" class="btn-remove-image" onclick="removeQuestionImage()" title="Supprimer l'image">
                        ✕
                    </button>
                </div>
            `;
        }
    }
    
    function removeQuestionImage() {
        const index = APP_STATE.editingQuestionIndex;
        if (index === null) return;
        
        const question = APP_STATE.questions[index];
        
        // Supprimer l'image
        delete question.imageUrl;
        
        // Mettre à jour l'aperçu
        const container = document.getElementById('question-image-container');
        if (container) {
            container.innerHTML = '';
        }
    }

    function renderFreeTextEditor(question) {
        // Initialiser les champs si nécessaire
        if (!question.caseSensitive) question.caseSensitive = false;
        if (!question.acceptedAnswers) question.acceptedAnswers = [];
        
        let html = '<div class="answers-editor freetext-editor">';
        html += '<p class="info-text">✍️ L\'élève devra saisir une réponse textuelle (max 300 caractères)</p>';
        
        html += `
            <div class="form-group">
                <label>Réponse correcte principale :</label>
                <input type="text" 
                       id="freetext-main-answer" 
                       class="answer-input" 
                       placeholder="Ex: Paris"
                       value="${question.answers[0] ? question.answers[0].text : ''}"
                       maxlength="300">
            </div>
        `;
        
        html += `
            <div class="form-group">
                <label>
                    <input type="checkbox" 
                           id="freetext-case-sensitive"
                           ${question.caseSensitive ? 'checked' : ''}>
                    Respecter la casse (majuscules/minuscules)
                </label>
            </div>
        `;
        
        html += `
            <div class="form-group">
                <label>Réponses alternatives acceptées (optionnel) :</label>
                <p class="info-text">Une réponse par ligne. Utile pour les variantes orthographiques.</p>
                <textarea id="freetext-alternatives" 
                          class="answer-input" 
                          placeholder="Ex: Île-de-France&#10;Paris France&#10;paris"
                          rows="4">${question.acceptedAnswers ? question.acceptedAnswers.join('\n') : ''}</textarea>
            </div>
        `;
        
        html += '</div>';
        return html;
    }

    function saveFreeTextAnswers(question) {
        const mainAnswer = document.getElementById('freetext-main-answer').value.trim();
        const caseSensitive = document.getElementById('freetext-case-sensitive').checked;
        const alternativesText = document.getElementById('freetext-alternatives').value.trim();
        
        // Sauvegarder la réponse principale
        question.answers[0].text = mainAnswer;
        question.caseSensitive = caseSensitive;
        
        // Sauvegarder les alternatives
        if (alternativesText) {
            question.acceptedAnswers = alternativesText
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
        } else {
            question.acceptedAnswers = [];
        }
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.addQuestion = addQuestion;
    window.closeAddQuestionModal = closeAddQuestionModal;
    window.createQuestion = createQuestion;
    window.renderQuestionsList = renderQuestionsList;
    window.editQuestion = editQuestion;
    window.closeEditQuestionModal = closeEditQuestionModal;
    window.saveEditedQuestion = saveEditedQuestion;
    window.moveQuestion = moveQuestion;
    window.deleteQuestion = deleteQuestion;
    window.updateAllQuestionTimes = updateAllQuestionTimes;
    window.applyTimeToAll = applyTimeToAll;
    window.addOrderItem = addOrderItem;
    window.removeOrderItem = removeOrderItem;
    window.openImageGalleryForQuestion = openImageGalleryForQuestion;
    window.setQuestionImage = setQuestionImage;
    window.removeQuestionImage = removeQuestionImage;

})();
