// ============================================
// MODULE: PARTIE (GAME)
// Description: Gestion complète de la partie élève
// ============================================

(function() {
    'use strict';

    // Variables de jeu
    let currentQuestionData = null;
    let questionStartTime = null;
    let hasAnswered = false;
    let answerTimeout = null;

    // ========================================
    // PAGE DE SÉLECTION (Collège + Animal)
    // ========================================
    
    async function showStudentJoinPage(playCode, quizName, totalQuestions = 0) {
        const gameContainer = document.querySelector('.game-container');
        
        // Réinitialiser la sélection d'animal
        selectedAnimal = null;
        
        // Initialiser la session élève avec le playCode et totalQuestions
        initStudentSession(playCode, { name: quizName, totalQuestions: totalQuestions });
        
        // Obtenir 3 animaux UNIQUES depuis le serveur
        let animals = [];
        try {
            const response = await fetch(`php/api.php?action=get_animals&code=${playCode}`);
            const result = await response.json();
            if (result.success) {
                animals = result.animals;
            } else {
                console.error('❌ Impossible d\'obtenir les animaux');
                animals = ['🐕 Chien', '🐈 Chat', '🐰 Lapin']; // Fallback
            }
        } catch (error) {
            console.error('❌ Erreur API animaux:', error);
            animals = ['🐕 Chien', '🐈 Chat', '🐰 Lapin']; // Fallback
        }
        
        let html = `
            <div class="join-page">
                <div class="join-header">
                    <h2>📝 ${quizName}</h2>
                    <p class="join-subtitle">Choisis ton avatar</p>
                </div>
                
                <div class="join-form">
                    <div class="form-group">
                        <label>🎭 Choisis ton avatar :</label>
                        <div class="animal-grid">
        `;
        
        animals.forEach((animal, index) => {
            html += `
                <button type="button" class="animal-btn" data-animal="${animal.replace(/"/g, '&quot;')}">
                    <span class="animal-emoji">${animal.split(' ')[0]}</span>
                    <span class="animal-name">${animal.split(' ')[1]}</span>
                </button>
            `;
        });
        
        html += `
                        </div>
                        <p class="animal-info">Ton pseudo sera ton animal 🦁</p>
                    </div>
                    
                    <button id="join-game-btn" class="btn-join-game" disabled>
                        🚀 Rejoindre la partie
                    </button>
                </div>
            </div>
        `;
        
        gameContainer.innerHTML = html;
        showPage('game-page');
        
        // IMPORTANT : Nettoyer toute sélection/focus résiduel
        setTimeout(() => {
            // Retirer TOUTES les classes selected qui pourraient avoir été ajoutées
            document.querySelectorAll('.animal-btn').forEach(btn => {
                btn.classList.remove('selected');
                btn.blur(); // Forcer la perte de focus
            });
            
            // Ajouter les event listeners APRÈS avoir créé le HTML
            document.querySelectorAll('.animal-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const animal = this.getAttribute('data-animal');
                    selectAnimal(animal);
                });
            });
            
            // Event listener pour le bouton rejoindre
            document.getElementById('join-game-btn').addEventListener('click', confirmJoinGame);
        }, 0);
    }

    let selectedAnimal = null;

    function selectAnimal(animal) {
        selectedAnimal = animal;
        
        // Retirer la sélection précédente
        document.querySelectorAll('.animal-btn').forEach(btn => {
            btn.classList.remove('selected');
        });
        
        // Trouver le bon bouton avec data-animal et ajouter la sélection
        const targetBtn = document.querySelector(`.animal-btn[data-animal="${animal}"]`);
        if (targetBtn) {
            targetBtn.classList.add('selected');
        }
        
        checkJoinButtonState();
    }

    function checkJoinButtonState() {
        const joinBtn = document.getElementById('join-game-btn');
        joinBtn.disabled = selectedAnimal === null;
    }

    async function confirmJoinGame() {
        if (!selectedAnimal) {
            alert('⚠️ Sélectionne un avatar');
            return;
        }
        
        // Enregistrer les infos (sans collège)
        setPlayerInfo('', selectedAnimal);
        
        // Rejoindre la session
        const success = await joinSession();
        
        if (success) {
            showWaitingRoom();
        } else {
            alert('❌ Impossible de rejoindre la partie');
        }
    }

    // ========================================
    // SALLE D'ATTENTE
    // ========================================
    
    function showWaitingRoom() {
        const gameContainer = document.querySelector('.game-container');
        
        gameContainer.innerHTML = `
            <div class="waiting-room">
                <div class="waiting-header">
                    <h2>⏳ En attente du démarrage...</h2>
                    <p class="waiting-subtitle">Le professeur va bientôt lancer la partie</p>
                </div>
                
                <div class="game-rules">
                    <p>⚡ Plus tu réponds correctement et rapidement, plus tu gagnes des points !</p>
                </div>
                
                <div class="players-container">
                    <h3>🎭 Joueurs connectés : <span id="player-count">0</span></h3>
                    <div id="players-list" class="players-grid">
                        <!-- Les joueurs apparaîtront ici -->
                    </div>
                </div>
                
                <div class="waiting-footer">
                    <p>✨ Ta connexion est active</p>
                    <div class="connection-pulse"></div>
                </div>
            </div>
        `;
    }

    function updateWaitingRoom(players) {
        const playersList = document.getElementById('players-list');
        const playerCount = document.getElementById('player-count');
        
        if (!playersList || !playerCount) return;
        
        playerCount.textContent = players.length;
        
        let html = '';
        players.forEach(player => {
            const isMe = player.nickname === SESSION_STATE.playerNickname;
            html += `
                <div class="player-card ${isMe ? 'is-me' : ''}">
                    <div class="player-avatar">${player.nickname.split(' ')[0]}</div>
                    <div class="player-name">${player.nickname.split(' ')[1]}</div>
                    ${isMe ? '<div class="player-badge">Toi</div>' : ''}
                </div>
            `;
        });
        
        // Ne mettre à jour que si le contenu a changé (évite le clignotement)
        if (playersList.innerHTML !== html) {
            playersList.innerHTML = html;
        }
    }

    // ========================================
    // DÉMARRAGE DE LA PARTIE
    // ========================================
    
    function handleGameStart(data) {
        const gameContainer = document.querySelector('.game-container');
        
        // Animation de compte à rebours
        gameContainer.innerHTML = `
            <div class="countdown-screen">
                <h2>🎮 La partie commence !</h2>
                <div class="countdown-number" id="countdown">3</div>
            </div>
        `;
        
        let count = 3;
        const countdownEl = document.getElementById('countdown');
        
        const interval = setInterval(() => {
            count--;
            if (count > 0) {
                countdownEl.textContent = count;
                countdownEl.style.animation = 'none';
                setTimeout(() => {
                    countdownEl.style.animation = 'pulse 1s ease';
                }, 10);
            } else {
                clearInterval(interval);
                countdownEl.textContent = 'GO ! 🚀';
                setTimeout(() => {
                    // La première question sera affichée par l'événement SSE
                }, 1000);
            }
        }, 1000);
    }

    // ========================================
    // AFFICHAGE D'UNE QUESTION
    // ========================================
    
    function displayQuestion(data) {
        console.log('🎯 ÉLÈVE: Affichage question', data);
        console.log('🔍 countdownState avant nettoyage:', countdownState);
        
        // Arrêter le compte à rebours des résultats s'il tourne encore
        if (countdownState && countdownState.interval) {
            clearInterval(countdownState.interval);
            countdownState.interval = null;
            countdownState.remaining = 10;
            console.log('⏹️ Compte à rebours des résultats arrêté et réinitialisé');
        }
        
        // Arrêter aussi le timer de question précédent si existe
        if (timerState && timerState.interval) {
            clearInterval(timerState.interval);
            timerState.interval = null;
            console.log('⏹️ Timer de question précédente arrêté');
        }
        
        currentQuestionData = data;
        
        // Utiliser le startTime du serveur si disponible (pour la synchronisation lors de reconnexion)
        // startTime est un timestamp Unix en secondes, on le convertit en millisecondes
        if (data.startTime) {
            questionStartTime = data.startTime * 1000; // Convertir secondes -> millisecondes
            console.log('⏱️ Utilisation du startTime serveur:', new Date(questionStartTime).toISOString());
        } else {
            questionStartTime = Date.now();
            console.log('⏱️ Utilisation de l\'heure locale');
        }
        
        hasAnswered = false;
        
        const gameContainer = document.querySelector('.game-container');
        const question = data.question;
        const questionNumber = data.index + 1;
        // Priorité: totalQuestions depuis data (envoyé par le serveur), puis SESSION_STATE
        const totalQuestions = data.totalQuestions || SESSION_STATE.quizData?.totalQuestions || SESSION_STATE.quizData?.questions?.length || 1;
        
        console.log('📊 ÉLÈVE: totalQuestions =', totalQuestions, '(data:', data.totalQuestions, ', session:', SESSION_STATE.quizData?.totalQuestions, ')');
        
        let html = `
            <div class="question-screen">
                <div class="question-screen-inner">
                    <div class="question-header">
                        <div class="player-nickname-display">
                            ${SESSION_STATE.playerNickname}
                        </div>
                        <div class="question-progress">
                            Question ${questionNumber} / ${totalQuestions}
                        </div>
                        <div class="question-timer">
                            <div class="timer-bar" id="timer-bar"></div>
                            <span id="timer-text">${question.time}s</span>
                        </div>
                    </div>
                    
                    <div class="question-content">
                        ${question.imageUrl ? `
                            <div class="question-image">
                                <img src="${question.imageUrl}" alt="Image de la question">
                            </div>
                        ` : ''}
                        <h2 class="question-text">${question.question}</h2>
                        
                        <div class="answers-container" id="answers-container">
        `;
        
        // Générer les réponses selon le type
        switch(question.type) {
            case 'multiple':
            case 'truefalse':
                // Mélanger les réponses avec leurs index d'origine
                const shuffledAnswers = question.answers.map((answer, index) => ({
                    answer: answer,
                    originalIndex: index
                })).sort(() => Math.random() - 0.5);
                
                shuffledAnswers.forEach((item, displayIndex) => {
                    html += `
                        <button type="button" class="answer-btn" data-answer-index="${item.originalIndex}">
                            ${item.answer.text}
                        </button>
                    `;
                });
                break;
                
            case 'order':
                html += '<div class="order-container">';
                // Mélanger les réponses
                const shuffled = [...question.answers].sort(() => Math.random() - 0.5);
                shuffled.forEach((answer, index) => {
                    html += `
                        <div class="order-item" draggable="true" data-text="${answer.text}" data-original-order="${answer.order}">
                            <span class="drag-handle">☰</span>
                            <span class="order-text">${answer.text}</span>
                        </div>
                    `;
                });
                html += '</div>';
                html += '<button class="btn-validate-order" onclick="validateOrder()">Valider l\'ordre</button>';
                break;
                
            case 'freetext':
                html += `
                    <div class="freetext-container">
                        <textarea id="freetext-answer" 
                                  class="freetext-input" 
                                  placeholder="Tapez votre réponse ici..."
                                  maxlength="300"
                                  rows="4"></textarea>
                        <div class="freetext-counter">
                            <span id="freetext-count">0</span> / 300 caractères
                        </div>
                        <button class="btn-validate-freetext" onclick="validateFreeText()">Valider ma réponse</button>
                    </div>
                `;
                break;
        }
        
        html += `
                    </div>
                </div>
            </div>
            </div>
        `;
        
        gameContainer.innerHTML = html;
        
        // Forcer la perte de focus de tout élément actif
        if (document.activeElement) {
            document.activeElement.blur();
        }
        
        // NETTOYER IMMÉDIATEMENT toute sélection résiduelle
        document.querySelectorAll('.answer-btn').forEach(btn => {
            btn.classList.remove('selected');
            btn.blur();
        });
        
        // IMPORTANT : Nettoyer et ajouter les event listeners avec un léger délai
        setTimeout(() => {
            // Retirer ENCORE toute sélection/focus résiduel (double sécurité)
            if (document.activeElement) {
                document.activeElement.blur();
            }
            document.querySelectorAll('.answer-btn').forEach(btn => {
                btn.classList.remove('selected');
                btn.blur();
            });
            
            // Ajouter les event listeners pour les boutons de réponse
            if (question.type === 'multiple' || question.type === 'truefalse') {
                document.querySelectorAll('.answer-btn').forEach(btn => {
                    btn.addEventListener('click', function() {
                        const answerIndex = parseInt(this.getAttribute('data-answer-index'));
                        selectAnswer(answerIndex);
                    });
                });
            }
        }, 100); // Augmenter à 100ms pour mobile
        
        // Démarrer le timer
        startQuestionTimer(question.time);
        
        // Initialiser le drag & drop si question d'ordre
        if (question.type === 'order') {
            initializeOrderDragDrop();
        }
        
        // Initialiser le compteur de caractères si question à réponse libre
        if (question.type === 'freetext') {
            const textarea = document.getElementById('freetext-answer');
            const counter = document.getElementById('freetext-count');
            if (textarea && counter) {
                textarea.addEventListener('input', function() {
                    counter.textContent = this.value.length;
                });
            }
        }
    }

    let timerState = {
        isPaused: false,
        remaining: 0,
        duration: 0,
        interval: null
    };
    
    let countdownState = {
        isPaused: false,
        remaining: 10,
        interval: null
    };

    function startQuestionTimer(duration) {
        const timerBar = document.getElementById('timer-bar');
        const timerText = document.getElementById('timer-text');
        
        // Calculer le temps déjà écoulé depuis le début de la question
        const elapsedSeconds = Math.floor((Date.now() - questionStartTime) / 1000);
        const remainingTime = Math.max(0, duration - elapsedSeconds);
        
        console.log(`⏱️ Timer: durée=${duration}s, écoulé=${elapsedSeconds}s, restant=${remainingTime}s`);
        
        timerState.remaining = remainingTime;
        timerState.duration = duration;
        timerState.isPaused = false;
        
        // Calculer le pourcentage initial
        const initialPercentage = (remainingTime / duration) * 100;
        timerBar.style.width = initialPercentage + '%';
        
        // Changer la couleur si déjà proche de la fin
        if (remainingTime <= 5) {
            timerBar.style.background = 'var(--error)';
        }
        
        if (timerState.interval) {
            clearInterval(timerState.interval);
        }
        
        // Si le temps est déjà écoulé, soumettre immédiatement
        if (remainingTime <= 0 && !hasAnswered) {
            autoSubmitNoAnswer();
            return;
        }
        
        timerState.interval = setInterval(() => {
            if (timerState.isPaused) {
                return; // Ne rien faire si en pause
            }
            
            timerState.remaining--;
            const percentage = (timerState.remaining / timerState.duration) * 100;
            
            if (timerBar && timerText) {
                timerBar.style.width = percentage + '%';
                timerText.textContent = timerState.remaining + 's';
                
                // Changer de couleur quand proche de la fin
                if (timerState.remaining <= 5) {
                    timerBar.style.background = 'var(--error)';
                }
            }
            
            if (timerState.remaining <= 0 || hasAnswered) {
                clearInterval(timerState.interval);
                timerState.interval = null;
                if (!hasAnswered) {
                    // Temps écoulé sans réponse
                    autoSubmitNoAnswer();
                }
            }
        }, 1000);
        
        answerTimeout = timerState.interval;
    }
    
    function handlePause(isPaused) {
        timerState.isPaused = isPaused;
        countdownState.isPaused = isPaused;
        
        // Afficher/masquer l'overlay de pause
        if (isPaused) {
            showPauseOverlay();
        } else {
            hidePauseOverlay();
        }
        
        // Gérer le timer de question
        const timerBar = document.getElementById('timer-bar');
        const timerText = document.getElementById('timer-text');
        
        if (timerBar && timerText && timerState.remaining > 0) {
            if (isPaused) {
                timerText.textContent = '⏸️ ' + timerState.remaining + 's';
                timerBar.style.opacity = '0.5';
            } else {
                timerText.textContent = timerState.remaining + 's';
                timerBar.style.opacity = '1';
            }
        }
        
        // Gérer le countdown du top 3
        const countdownEl = document.getElementById('countdown-next');
        if (countdownEl && countdownState.remaining > 0) {
            if (isPaused) {
                countdownEl.textContent = '⏸️ ' + countdownState.remaining;
            } else {
                countdownEl.textContent = countdownState.remaining;
            }
        }
    }
    
    function showPauseOverlay() {
        // Supprimer l'ancien overlay s'il existe
        let overlay = document.getElementById('pause-overlay');
        if (overlay) return;
        
        // Créer l'overlay
        overlay = document.createElement('div');
        overlay.id = 'pause-overlay';
        overlay.innerHTML = `
            <div class="pause-content">
                <div class="pause-icon">⏸️</div>
                <h2>Partie en pause</h2>
                <p>Le professeur a mis le jeu en pause.<br>Merci de patienter...</p>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    
    function hidePauseOverlay() {
        const overlay = document.getElementById('pause-overlay');
        if (overlay) {
            overlay.remove();
        }
    }

    async function selectAnswer(index) {
        console.log('🔵 selectAnswer appelé:', { hasAnswered, isPaused: timerState.isPaused });
        if (hasAnswered || timerState.isPaused === true) return;
        
        hasAnswered = true;
        const timeSpent = Date.now() - questionStartTime; // Millisecondes
        
        // Désactiver tous les boutons
        document.querySelectorAll('.answer-btn').forEach((btn, i) => {
            btn.disabled = true;
            if (i === index) {
                btn.classList.add('selected');
            }
        });
        
        // Envoyer la réponse
        await submitAnswer({ index }, timeSpent);
        
        // Afficher un feedback
        showAnswerFeedback();
    }

    async function validateOrder() {
        if (hasAnswered || timerState.isPaused === true) return;
        
        hasAnswered = true;
        const timeSpent = Date.now() - questionStartTime; // Millisecondes
        
        // Récupérer l'ordre actuel
        const items = document.querySelectorAll('.order-item');
        const userOrder = Array.from(items).map(item => item.getAttribute('data-text'));
        
        // Désactiver le bouton
        event.target.disabled = true;
        event.target.textContent = '✅ Réponse envoyée';
        
        // Envoyer la réponse
        await submitAnswer({ order: userOrder }, timeSpent);
        
        // Afficher un feedback
        showAnswerFeedback();
    }

    async function autoSubmitNoAnswer() {
        if (hasAnswered) return;
        
        hasAnswered = true;
        const timeSpent = currentQuestionData.question.time;
        
        // Envoyer une réponse vide
        await submitAnswer({ index: -1 }, timeSpent);
        
        // Afficher un feedback
        showAnswerFeedback('Temps écoulé ! ⏰');
    }

    function showAnswerFeedback(message = 'Réponse enregistrée ! ✅') {
        const container = document.getElementById('answers-container');
        if (!container) {
            return; // La page a changé, ne rien faire
        }
        container.innerHTML = `
            <div class="answer-feedback">
                <div class="feedback-text">${message}</div>
                <div class="feedback-subtext">En attente des autres joueurs...</div>
                <div id="stuck-warning" style="display: none; margin-top: 20px; padding: 15px; background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; color: #856404;">
                    ⚠️ Cela prend plus de temps que prévu...<br>
                    <small>Le professeur peut débloquer la situation avec le bouton "Resynchroniser"</small>
                </div>
            </div>
        `;
        
        // Détection de blocage prolongé (30 secondes)
        const stuckTimeout = setTimeout(() => {
            const warning = document.getElementById('stuck-warning');
            if (warning) {
                warning.style.display = 'block';
                console.warn('⚠️ ÉLÈVE: Bloqué depuis 30s sur "Réponse enregistrée"');
            }
        }, 30000);
        
        // Nettoyer le timeout si on quitte cette page
        const observer = new MutationObserver(() => {
            if (!document.getElementById('answers-container')) {
                clearTimeout(stuckTimeout);
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ========================================
    // DRAG & DROP POUR ORDRE
    // ========================================
    
    function initializeOrderDragDrop() {
        const container = document.querySelector('.order-container');
        if (!container) return;
        
        const items = container.querySelectorAll('.order-item');
        
        // Variables pour le drag tactile
        let draggedItem = null;
        let placeholder = null;
        let offsetY = 0;
        let originalWidth = 0;
        
        items.forEach(item => {
            // Support tactile (mobile)
            item.addEventListener('touchstart', function(e) {
                draggedItem = this;
                const touch = e.touches[0];
                const rect = this.getBoundingClientRect();
                
                // Calculer l'offset entre le doigt et le haut de l'élément
                offsetY = touch.clientY - rect.top;
                originalWidth = rect.width;
                
                // Créer un placeholder
                placeholder = document.createElement('div');
                placeholder.className = 'order-item-placeholder';
                placeholder.style.height = rect.height + 'px';
                placeholder.style.margin = window.getComputedStyle(this).margin;
                placeholder.style.visibility = 'hidden';
                
                // Insérer le placeholder à la place de l'élément
                this.parentNode.insertBefore(placeholder, this);
                
                // Passer l'élément en position fixed pour qu'il suive le doigt
                this.style.position = 'fixed';
                this.style.width = originalWidth + 'px';
                this.style.left = rect.left + 'px';
                this.style.top = rect.top + 'px';
                this.style.margin = '0';
                this.style.zIndex = '1000';
                this.classList.add('dragging');
                
                e.preventDefault();
            }, { passive: false });
            
            item.addEventListener('touchmove', function(e) {
                if (!draggedItem || draggedItem !== this) return;
                
                e.preventDefault();
                const touch = e.touches[0];
                
                // Déplacer l'élément pour qu'il suive le doigt
                this.style.top = (touch.clientY - offsetY) + 'px';
                
                // Trouver sur quel élément on est
                const otherItems = Array.from(container.querySelectorAll('.order-item:not(.dragging)'));
                
                let targetItem = null;
                let insertBefore = true;
                
                for (let otherItem of otherItems) {
                    const rect = otherItem.getBoundingClientRect();
                    const middle = rect.top + rect.height / 2;
                    
                    if (touch.clientY < middle) {
                        targetItem = otherItem;
                        insertBefore = true;
                        break;
                    }
                }
                
                // Déplacer le placeholder
                if (targetItem) {
                    container.insertBefore(placeholder, targetItem);
                } else {
                    // Ajouter à la fin
                    container.appendChild(placeholder);
                }
            }, { passive: false });
            
            item.addEventListener('touchend', function(e) {
                if (draggedItem === this) {
                    e.preventDefault();
                    
                    // Remettre l'élément à sa position normale
                    this.style.position = '';
                    this.style.width = '';
                    this.style.left = '';
                    this.style.top = '';
                    this.style.margin = '';
                    this.style.zIndex = '';
                    this.classList.remove('dragging');
                    
                    // Remplacer le placeholder par l'élément réel
                    if (placeholder && placeholder.parentNode) {
                        placeholder.parentNode.insertBefore(this, placeholder);
                        placeholder.remove();
                    }
                    
                    draggedItem = null;
                    placeholder = null;
                }
            }, { passive: false });
            
            item.addEventListener('touchcancel', function(e) {
                if (draggedItem === this) {
                    // Même chose que touchend
                    this.style.position = '';
                    this.style.width = '';
                    this.style.left = '';
                    this.style.top = '';
                    this.style.margin = '';
                    this.style.zIndex = '';
                    this.classList.remove('dragging');
                    
                    if (placeholder && placeholder.parentNode) {
                        placeholder.parentNode.insertBefore(this, placeholder);
                        placeholder.remove();
                    }
                    
                    draggedItem = null;
                    placeholder = null;
                }
            }, { passive: false });
            
            // Support souris (desktop) - pour rétrocompatibilité
            item.addEventListener('dragstart', function(e) {
                draggedItem = this;
                setTimeout(() => this.classList.add('dragging'), 0);
            });
            
            item.addEventListener('dragend', function() {
                this.classList.remove('dragging');
            });
            
            item.addEventListener('dragover', function(e) {
                e.preventDefault();
                const afterElement = getDragAfterElement(container, e.clientY);
                if (afterElement == null) {
                    container.appendChild(draggedItem);
                } else {
                    container.insertBefore(draggedItem, afterElement);
                }
            });
        });
    }

    function getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.order-item:not(.dragging)')];
        
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    // ========================================
    // RÉSULTATS DE LA QUESTION
    // ========================================
    
    function generateQuestionStatsHTML(data, myData, allPlayers) {
        console.log('📊 generateQuestionStatsHTML appelé');
        console.log('📊 data.questionStats:', data.questionStats);
        console.log('📊 myData:', myData);
        console.log('📊 SESSION_STATE.playerNickname:', SESSION_STATE.playerNickname);
        
        if (!data.questionStats) {
            console.warn('⚠️ Pas de questionStats dans data');
            return `
                <div class="question-stats-container">
                    <h3 class="section-title">📝 Question précédente</h3>
                    <p style="color: red;">DEBUG: Pas de questionStats reçu du serveur</p>
                </div>
            `;
        }
        
        // Trouver mes stats pour cette question
        const myStats = data.questionStats.find(s => s.nickname === SESSION_STATE.playerNickname);
        
        console.log('📊 myStats trouvé:', myStats);
        
        if (!myStats) {
            console.warn('⚠️ Pas de stats pour mon pseudo');
            const receivedNicknames = data.questionStats.map(s => s.nickname).join(', ');
            return `
                <div class="question-stats-container">
                    <h3 class="section-title">📝 Question précédente</h3>
                    <p style="color: orange;">DEBUG: Stats non trouvées pour "${SESSION_STATE.playerNickname}"</p>
                    <p>Pseudos reçus: ${receivedNicknames}</p>
                    <p>Nombre de stats: ${data.questionStats.length}</p>
                </div>
            `;
        }
        
        if (!myStats) return '';
        
        const isCorrect = myStats.correct;
        const timeSpent = myStats.timeSpent || 0;
        const pointsEarned = myStats.pointsEarned || 0;
        
        // Convertir en millièmes (3 décimales)
        const timeDisplay = (timeSpent / 1000).toFixed(3);
        
        let html = `
            <div class="question-stats-container">
                <h3 class="section-title">📝 Question précédente</h3>
                
                <div class="question-result-centered">
                    <div class="question-result ${isCorrect ? 'correct' : 'incorrect'}">
                        <div class="result-icon">${isCorrect ? '✅' : '❌'}</div>
                        <div class="result-text">
                            <div class="result-label">${isCorrect ? 'Bonne réponse !' : 'Mauvaise réponse'}</div>
                            ${isCorrect ? `
                                <div class="result-details">
                                    ⏱️ Ton temps de réponse : ${timeDisplay}s
                                </div>
                                <div class="result-points">
                                    🎯 +${pointsEarned} pts
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
                
                ${!isCorrect && data.question ? `
                    <div class="wrong-answer-explanation">
                        <div class="question-reminder">
                            <strong>Question :</strong> ${data.question.question}
                        </div>
                        <div class="correct-answer-display">
                            <strong>La bonne réponse était :</strong><br>
                            ${formatCorrectAnswer(data.question, data.correctAnswer)}
                        </div>
                    </div>
                ` : ''}
        `;
        
        // Top 5 des plus rapides
        if (data.top5Fastest && data.top5Fastest.length > 0) {
            html += `
                <div class="top5-fastest">
                    <h4>⚡ Top 5 des plus rapides</h4>
                    <div class="fastest-list">
            `;
            
            data.top5Fastest.forEach((player, index) => {
                const fastTime = (player.timeSpent / 1000).toFixed(3);
                const isMe = player.nickname === SESSION_STATE.playerNickname;
                html += `
                    <div class="fastest-item ${isMe ? 'is-me' : ''}">
                        <span class="fastest-rank">#${index + 1}</span>
                        <span class="fastest-name">${player.nickname}</span>
                        <span class="fastest-time">⏱️ ${fastTime}s</span>
                        <span class="fastest-points">🎯 ${player.pointsEarned}pts</span>
                    </div>
                `;
            });
            
            html += `
                    </div>
                </div>
            `;
        }
        
        html += `
                <div class="ranking-actions">
                    <button class="btn-secondary" onclick="showFullRanking()">
                        📋 Voir classement général
                    </button>
                </div>
            </div>
        `;
        
        return html;
    }
    
    function displayQuestionResults(data) {
        console.log('📊 ÉLÈVE: Affichage résultats', data);
        console.log('🔍 data.manualMode =', data.manualMode, ', type =', typeof data.manualMode);
        
        const gameContainer = document.querySelector('.game-container');
        
        // Debug complet des données reçues
        console.log('📊 DONNÉES REÇUES:', {
            hasQuestionStats: !!data.questionStats,
            questionStats: data.questionStats,
            hasAllPlayers: !!data.allPlayers,
            hasPlayers: !!data.players,
            playersCount: (data.allPlayers || data.players || []).length
        });
        
        // Utiliser allPlayers si disponible, sinon players
        const players = data.allPlayers || data.players || [];
        
        if (players.length === 0) {
            console.error('❌ Aucun joueur dans les résultats');
            return;
        }
        
        // Vérifier si c'est la dernière question - PRIORITÉ aux données serveur
        const totalQuestions = data.totalQuestions || SESSION_STATE.quizData?.totalQuestions || SESSION_STATE.quizData?.questions?.length || 0;
        const isLastQuestion = data.isLastQuestion !== undefined ? data.isLastQuestion : (totalQuestions > 0 && data.questionIndex >= (totalQuestions - 1));
        
        console.log('📊 ÉLÈVE: isLastQuestion =', isLastQuestion, '(data:', data.isLastQuestion, ', calculated:', data.questionIndex, '>=', totalQuestions - 1, ')');
        
        // Trouver ma position et mon score
        const myData = players.find(p => p.nickname === SESSION_STATE.playerNickname);
        const myScore = myData ? myData.score : 0;
        const myPosition = myData ? players.indexOf(myData) + 1 : '-';
        
        // Top 3
        const top3 = data.top3 || players.slice(0, 3);
        
        let html = `
            <div class="results-screen">
                <h2>📊 Résultats</h2>
                
                <div class="my-results">
                    <div class="my-stats-row">
                        <div class="my-nickname">
                            ${SESSION_STATE.playerNickname}
                        </div>
                        <div class="my-score">
                            <div class="score-label">Score total</div>
                            <div class="score-value">${myScore} pts</div>
                        </div>
                        <div class="my-position">
                            <div class="position-label">Ta position</div>
                            <div class="position-value">#${myPosition}</div>
                        </div>
                    </div>
                </div>
                
                ${generateQuestionStatsHTML(data, myData, players)}
                
                <div class="waiting-next">
                    ${data.manualMode ? 
                        (isLastQuestion ? 
                            '<p>🏁 En attente du professeur pour le podium final...</p>' :
                            '<p>🎯 En attente du professeur pour la prochaine question...</p>') :
                        (isLastQuestion ?
                            '<p>🏁 Podium final dans <span id="countdown-next">10</span>s...</p>' :
                            '<p>⏳ Prochaine question dans <span id="countdown-next">10</span>s...</p>')
                    }
                    <div class="dots-loader">
                        <span></span><span></span><span></span>
                    </div>
                </div>
            </div>
        `;
        
        gameContainer.innerHTML = html;
        
        // Stocker les données pour le classement complet
        window.currentRankingData = players;
        
        console.log('🔍 Mode manuel:', data.manualMode);
        
        // Démarrer le compte à rebours seulement en mode automatique
        if (!data.manualMode) {
            // Arrêter l'intervalle existant si présent
            if (countdownState.interval) {
                clearInterval(countdownState.interval);
                countdownState.interval = null;
            }
            
            // Initialiser le compte à rebours
            countdownState.remaining = 10;
            countdownState.isPaused = false;
            
            // Fonction pour mettre à jour l'affichage
            const updateCountdown = () => {
                const countdownEl = document.getElementById('countdown-next');
                if (countdownEl) {
                    countdownEl.textContent = countdownState.remaining;
                }
            };
            
            // Première mise à jour immédiate pour afficher 10
            updateCountdown();
            
            // Puis décrémenter chaque seconde
            countdownState.interval = setInterval(() => {
                if (countdownState.isPaused) {
                    return; // Ne rien faire si en pause
                }
                
                countdownState.remaining--;
                updateCountdown();
                
                if (countdownState.remaining <= 0) {
                    clearInterval(countdownState.interval);
                    countdownState.interval = null;
                }
            }, 1000);
        }
    }
    
    function showFullRanking() {
        const players = window.currentRankingData || [];
        
        // Créer la modale
        let html = `
            <div class="modal-overlay" onclick="closeFullRanking()">
                <div class="modal-content ranking-modal" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <h3>📊 Classement complet</h3>
                        <button class="modal-close" onclick="closeFullRanking()">✕</button>
                    </div>
                    
                    <div class="ranking-list">
        `;
        
        players.forEach((player, index) => {
            const isMe = player.nickname === SESSION_STATE.playerNickname;
            html += `
                <div class="ranking-item ${isMe ? 'is-me' : ''}">
                    <div class="ranking-position">#${index + 1}</div>
                    <div class="ranking-avatar">${player.nickname.split(' ')[0]}</div>
                    <div class="ranking-name">${player.nickname.split(' ')[1]}</div>
                    <div class="ranking-score">${player.score || 0} pts</div>
                </div>
            `;
        });
        
        // Vérifier si un countdown est actif
        const hasCountdown = document.getElementById('countdown-next') !== null;
        
        html += `
                    </div>
                    ${hasCountdown ? `
                    <div class="modal-footer">
                        <p class="countdown-text">⏳ Prochaine question dans <span id="countdown-modal">--</span>s</p>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
        
        // Ajouter au body
        const modalDiv = document.createElement('div');
        modalDiv.id = 'full-ranking-modal';
        modalDiv.innerHTML = html;
        document.body.appendChild(modalDiv);
        
        // Synchroniser le compte à rebours seulement s'il existe
        if (hasCountdown) {
            syncCountdown();
        }
    }
    
    function closeFullRanking() {
        const modal = document.getElementById('full-ranking-modal');
        if (modal) {
            modal.remove();
        }
    }
    
    function syncCountdown() {
        // Synchroniser le compte à rebours entre la page et la modale
        const mainCountdown = document.getElementById('countdown-next');
        const modalCountdown = document.getElementById('countdown-modal');
        
        if (mainCountdown && modalCountdown) {
            // Mettre à jour immédiatement
            modalCountdown.textContent = mainCountdown.textContent;
            
            // Synchroniser en continu
            const syncInterval = setInterval(() => {
                if (mainCountdown && modalCountdown && document.getElementById('full-ranking-modal')) {
                    modalCountdown.textContent = mainCountdown.textContent;
                } else {
                    clearInterval(syncInterval);
                }
            }, 100);
        }
    }

    // ========================================
    // FIN DE PARTIE
    // ========================================
    
    function displayFinalResults(data) {
        const gameContainer = document.querySelector('.game-container');
        
        // Arrêter TOUS les timers actifs
        if (timerState.interval) {
            clearInterval(timerState.interval);
            timerState.interval = null;
        }
        if (countdownState.interval) {
            clearInterval(countdownState.interval);
            countdownState.interval = null;
        }
        
        // Stocker les données complètes pour le récapitulatif
        window.finalResultsData = data;
        
        // Utiliser allPlayers si disponible
        const players = data.allPlayers || data.players || [];
        
        if (players.length === 0) {
            console.error('❌ Aucun joueur dans les résultats finaux');
            return;
        }
        
        // Trouver ma position
        const myData = players.find(p => p.nickname === SESSION_STATE.playerNickname);
        const myPosition = myData ? players.indexOf(myData) + 1 : '-';
        const myScore = myData ? myData.score : 0;
        
        // Top 3
        const top3 = players.slice(0, 3);
        
        let html = `
            <div class="final-screen">
                <h2>🎉 Partie terminée !</h2>
                
                <div class="final-my-results">
                    <div class="final-position">#${myPosition}</div>
                    <div class="final-score">${myScore} points</div>
                    ${myPosition <= 3 ? '<div class="final-badge">🏆 Top 3 !</div>' : ''}
                </div>
                
                <div class="final-top3">
                    <h3>🏆 Podium final</h3>
                    <div class="final-podium">
        `;
        
        const medals = ['🥇', '🥈', '🥉'];
        
        // Ordre d'affichage : 2ème, 1er, 3ème
        // Hauteurs : 2ème = moyen, 1er = haut, 3ème = bas
        const displayOrder = [1, 0, 2]; // Indices dans top3
        const heights = ['100px', '140px', '80px']; // Hauteurs correspondantes
        
        displayOrder.forEach((originalIndex, displayIndex) => {
            if (originalIndex >= top3.length) return; // Pas assez de joueurs
            
            const player = top3[originalIndex];
            const isMe = player.nickname === SESSION_STATE.playerNickname;
            const rank = originalIndex + 1;
            
            html += `
                <div class="final-podium-item rank-${rank} ${isMe ? 'is-me' : ''}" style="height: ${heights[displayIndex]}">
                    <div class="final-rank">#${rank}</div>
                    <div class="final-medal">${medals[originalIndex]}</div>
                    <div class="final-avatar">${player.nickname.split(' ')[0]}</div>
                    <div class="final-name">${player.nickname.split(' ')[1]}</div>
                    <div class="final-points">${player.score} pts</div>
                </div>
            `;
        });
        
        html += `
                    </div>
                    
                    <div class="ranking-actions" style="margin-top: var(--space-lg);">
                        <button class="btn-secondary" onclick="showMyRecap()" style="margin-bottom: var(--space-md);">
                            📊 Récap de mon parcours
                        </button>
                        <button class="btn-secondary" onclick="showFullRanking()">
                            📋 Voir le classement complet
                        </button>
                    </div>
                </div>
                
                <div class="final-actions">
                    <button class="btn-home" onclick="goBackHome()">
                        🏠 Retour à l'accueil
                    </button>
                </div>
            </div>
        `;
        
        gameContainer.innerHTML = html;
        
        // Stocker les données pour le classement complet
        window.currentRankingData = players;
        
        // Lancer des confettis si dans le top 3
        if (myPosition <= 3) {
            launchConfetti();
        }
    }

    function goBackHome() {
        leaveSession();
        showPage('home-page');
        document.getElementById('quiz-code-input').value = '';
        document.getElementById('quiz-code-input').focus();
    }

    function launchConfetti() {
        // Animation simple de confettis
        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8'];
        const confettiCount = 50;
        
        for (let i = 0; i < confettiCount; i++) {
            setTimeout(() => {
                const confetti = document.createElement('div');
                confetti.className = 'confetti';
                confetti.style.left = Math.random() * 100 + '%';
                confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
                confetti.style.animationDuration = (Math.random() * 3 + 2) + 's';
                document.body.appendChild(confetti);
                
                setTimeout(() => confetti.remove(), 5000);
            }, i * 30);
        }
    }

    async function validateFreeText() {
        if (hasAnswered || timerState.isPaused === true) return;
        
        hasAnswered = true;
        const timeSpent = Date.now() - questionStartTime; // Millisecondes
        
        const textarea = document.getElementById('freetext-answer');
        const userAnswer = textarea.value.trim();
        
        // Désactiver le textarea et le bouton
        textarea.disabled = true;
        const btn = document.querySelector('.btn-validate-freetext');
        if (btn) {
            btn.disabled = true;
            btn.classList.add('selected');
        }
        
        // Envoyer la réponse
        await submitAnswer({ freetext: userAnswer }, timeSpent);
        
        // Afficher un feedback
        showAnswerFeedback();
    }

    // ========================================
    // HELPER: FORMATER LA BONNE RÉPONSE
    // ========================================
    
    function formatCorrectAnswer(question, correctAnswer) {
        switch(question.type) {
            case 'multiple':
            case 'truefalse':
                if (question.answers[correctAnswer]) {
                    return `<span class="correct-answer-text">${question.answers[correctAnswer].text}</span>`;
                }
                return 'Non disponible';
            
            case 'order':
                if (Array.isArray(correctAnswer)) {
                    return correctAnswer.map((text, i) => 
                        `<div>${i + 1}. ${text}</div>`
                    ).join('');
                }
                return 'Non disponible';
            
            case 'freetext':
                return `<span class="correct-answer-text">${correctAnswer}</span>`;
            
            default:
                return 'Non disponible';
        }
    }
    
    // ========================================
    // RÉCAPITULATIF DU PARCOURS
    // ========================================
    
    function showMyRecap() {
        const data = window.finalResultsData;
        
        if (!data || !data.questionsWithAnswers) {
            alert('Données non disponibles');
            return;
        }
        
        const questions = data.questionsWithAnswers;
        const myPlayer = (data.allPlayers || data.players || []).find(p => 
            p.nickname === SESSION_STATE.playerNickname
        );
        
        if (!myPlayer) {
            alert('Impossible de trouver tes réponses');
            return;
        }
        
        const myAnswers = myPlayer.answers || {};
        
        // Créer la modale
        let html = `
            <div class="modal-overlay" onclick="closeMyRecap()">
                <div class="modal-content recap-modal" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <h3>📊 Récapitulatif de mon parcours</h3>
                        <button class="modal-close" onclick="closeMyRecap()">✕</button>
                    </div>
                    
                    <div class="recap-content">
                        <div class="recap-summary">
                            <div class="recap-stat">
                                <strong>Score total :</strong> ${myPlayer.score || 0} points
                            </div>
                            <div class="recap-stat">
                                <strong>Questions répondues :</strong> ${Object.keys(myAnswers).length} / ${questions.length}
                            </div>
                        </div>
        `;
        
        // Parcourir toutes les questions
        questions.forEach((q, index) => {
            const myAnswer = myAnswers[index];
            const isCorrect = myAnswer ? (myAnswer.correct || false) : false;
            const hasAnswered = myAnswer !== undefined;
            
            html += `
                <div class="recap-question ${isCorrect ? 'correct' : (hasAnswered ? 'incorrect' : 'not-answered')}">
                    <div class="recap-question-number">Question ${index + 1}</div>
                    <div class="recap-question-text">${q.question}</div>
            `;
            
            if (!hasAnswered) {
                html += `<div class="recap-no-answer">❌ Non répondu</div>`;
            } else {
                // Afficher la réponse de l'élève
                html += `<div class="recap-user-answer">`;
                
                if (isCorrect) {
                    html += `<div class="recap-answer-label correct-label">✅ Ta réponse (correcte) :</div>`;
                } else {
                    html += `<div class="recap-answer-label wrong-label">❌ Ta réponse :</div>`;
                }
                
                html += `<div class="recap-answer-value ${isCorrect ? 'correct-value' : 'wrong-value'}">`;
                html += formatUserAnswer(q, myAnswer);
                html += `</div></div>`;
                
                // Si incorrect, afficher la bonne réponse
                if (!isCorrect) {
                    html += `
                        <div class="recap-correct-answer">
                            <div class="recap-answer-label correct-label">✅ Bonne réponse :</div>
                            <div class="recap-answer-value correct-value">
                                ${formatCorrectAnswerForRecap(q)}
                            </div>
                        </div>
                    `;
                }
                
                // Afficher les points gagnés
                const points = myAnswer.points || 0;
                if (points > 0) {
                    html += `<div class="recap-points">🎯 +${points} points</div>`;
                } else {
                    html += `<div class="recap-points">0 point</div>`;
                }
            }
            
            html += `</div>`;
        });
        
        html += `
                    </div>
                </div>
            </div>
        `;
        
        // Ajouter au body
        const modalDiv = document.createElement('div');
        modalDiv.id = 'my-recap-modal';
        modalDiv.innerHTML = html;
        document.body.appendChild(modalDiv);
    }
    
    function formatUserAnswer(question, answer) {
        // La structure de answer stockée côté serveur est :
        // { questionIndex: number, answer: '{"index":1}', timeSpent: number, correct: bool, points: number }
        // Où answer.answer est une CHAÎNE JSON qu'il faut parser
        
        console.log('🔍 formatUserAnswer appelé:', { questionType: question.type, answer });
        
        // Parser la réponse si c'est une chaîne JSON
        let parsedAnswer = answer;
        if (answer.answer && typeof answer.answer === 'string') {
            try {
                parsedAnswer = JSON.parse(answer.answer);
                console.log('✅ Réponse parsée:', parsedAnswer);
            } catch (e) {
                console.error('❌ Erreur parsing JSON:', e);
                return 'Réponse non valide';
            }
        }
        
        switch(question.type) {
            case 'multiple':
            case 'truefalse':
                // Vérifier d'abord si parsedAnswer a directement index
                if (parsedAnswer.index !== undefined && question.answers[parsedAnswer.index]) {
                    return question.answers[parsedAnswer.index].text;
                }
                console.warn('❌ Impossible de formater la réponse multiple/truefalse:', parsedAnswer);
                return 'Réponse non valide';
            
            case 'order':
                // Vérifier si parsedAnswer a directement order
                if (Array.isArray(parsedAnswer.order)) {
                    return parsedAnswer.order.map((text, i) => 
                        `<div>${i + 1}. ${text}</div>`
                    ).join('');
                }
                console.warn('❌ Impossible de formater la réponse order:', parsedAnswer);
                return 'Réponse non valide';
            
            case 'freetext':
                // Vérifier si parsedAnswer a directement freetext
                if (parsedAnswer.freetext) {
                    return parsedAnswer.freetext;
                }
                console.warn('❌ Impossible de formater la réponse freetext:', parsedAnswer);
                return 'Réponse vide';
            
            default:
                return 'Type inconnu';
        }
    }
    
    function formatCorrectAnswerForRecap(question) {
        const correctAnswer = question.correctAnswer;
        
        switch(question.type) {
            case 'multiple':
            case 'truefalse':
                if (correctAnswer && correctAnswer.text) {
                    return correctAnswer.text;
                }
                return 'Non disponible';
            
            case 'order':
                if (Array.isArray(correctAnswer)) {
                    return correctAnswer.map((text, i) => 
                        `<div>${i + 1}. ${text}</div>`
                    ).join('');
                }
                return 'Non disponible';
            
            case 'freetext':
                if (correctAnswer && correctAnswer.text) {
                    let result = correctAnswer.text;
                    if (correctAnswer.acceptedAnswers && correctAnswer.acceptedAnswers.length > 0) {
                        result += '<br><small>(Réponses acceptées : ' + correctAnswer.acceptedAnswers.join(', ') + ')</small>';
                    }
                    return result;
                }
                return 'Non disponible';
            
            default:
                return 'Type inconnu';
        }
    }
    
    function closeMyRecap() {
        const modal = document.getElementById('my-recap-modal');
        if (modal) {
            modal.remove();
        }
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.showStudentJoinPage = showStudentJoinPage;
    window.selectAnimal = selectAnimal;
    window.confirmJoinGame = confirmJoinGame;
    window.showMyRecap = showMyRecap;
    window.closeMyRecap = closeMyRecap;
    window.updateWaitingRoom = updateWaitingRoom;
    window.handleGameStart = handleGameStart;
    window.displayQuestion = displayQuestion;
    window.selectAnswer = selectAnswer;
    window.validateOrder = validateOrder;
    window.validateFreeText = validateFreeText;
    window.displayQuestionResults = displayQuestionResults;
    window.displayFinalResults = displayFinalResults;
    window.showFullRanking = showFullRanking;
    window.closeFullRanking = closeFullRanking;
    window.handlePause = handlePause;
    window.goBackHome = goBackHome;

})();
