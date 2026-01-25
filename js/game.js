// ============================================
// MODULE: PARTIE (GAME)
// Description: Gestion complète de la partie élève
// ============================================

(function() {
    'use strict';

    // Variables de jeu
    let currentQuestionData = null;
    let questionStartTime = null;        // Pour le calcul des POINTS (heure locale d'affichage)
    let serverQuestionStartTime = null;  // Pour le TIMER visuel (heure serveur, reconnexion)
    let hasAnswered = false;
    let answerTimeout = null;

    // ========================================
    // AJUSTEMENT DYNAMIQUE DE LA MISE EN PAGE
    // ========================================
    
    /**
     * Ajuste dynamiquement la mise en page pour que tout soit visible sans scroll
     * Principe : Le texte de la question prend sa taille naturelle, 
     * puis l'image et les réponses se partagent l'espace restant
     */
    function adjustQuestionLayout() {
        const questionScreen = document.querySelector('.question-screen');
        const questionContent = document.querySelector('.question-content');
        const questionHeader = document.querySelector('.question-header');
        const questionText = document.querySelector('.question-text');
        const questionImage = document.querySelector('.question-image');
        const answersContainer = document.querySelector('.answers-container') || 
                                 document.querySelector('.order-container')?.parentElement ||
                                 document.querySelector('.freetext-container')?.parentElement;
        
        if (!questionScreen || !questionContent || !questionText) return;
        
        // Hauteur totale disponible (viewport)
        const viewportHeight = window.innerHeight;
        
        // Padding du conteneur principal
        const screenStyle = window.getComputedStyle(questionScreen);
        const screenPaddingTop = parseFloat(screenStyle.paddingTop) || 0;
        const screenPaddingBottom = parseFloat(screenStyle.paddingBottom) || 0;
        
        // Hauteur du header
        const headerHeight = questionHeader ? questionHeader.offsetHeight : 0;
        
        // Padding du content
        const contentStyle = window.getComputedStyle(questionContent);
        const contentPaddingTop = parseFloat(contentStyle.paddingTop) || 0;
        const contentPaddingBottom = parseFloat(contentStyle.paddingBottom) || 0;
        
        // Gaps entre éléments (approximation)
        const gaps = 20;
        
        // Hauteur disponible pour le contenu (image + texte + réponses)
        const availableHeight = viewportHeight - screenPaddingTop - screenPaddingBottom 
                                - headerHeight - contentPaddingTop - contentPaddingBottom - gaps;
        
        // ÉTAPE 1 : Laisser le texte prendre sa taille naturelle
        questionText.style.maxHeight = 'none';
        questionText.style.overflow = 'visible';
        const textHeight = questionText.scrollHeight;
        
        // ÉTAPE 2 : Calculer l'espace restant pour image et réponses
        let remainingHeight = availableHeight - textHeight - 10; // 10px de marge
        
        // Si le texte prend plus de 40% de l'écran, on le limite et on force un affichage compact
        const maxTextHeight = availableHeight * 0.4;
        if (textHeight > maxTextHeight) {
            // Réduire la taille de police du texte pour qu'il rentre
            const currentFontSize = parseFloat(window.getComputedStyle(questionText).fontSize);
            const ratio = maxTextHeight / textHeight;
            const newFontSize = Math.max(14, currentFontSize * ratio * 0.95); // Min 14px
            questionText.style.fontSize = newFontSize + 'px';
            remainingHeight = availableHeight - maxTextHeight - 10;
        }
        
        // ÉTAPE 3 : Répartir l'espace restant entre image et réponses
        if (questionImage && answersContainer) {
            // Avec image : 30% image, 70% réponses de l'espace restant
            const imageMaxHeight = Math.max(50, remainingHeight * 0.3);
            const answersMinHeight = Math.max(100, remainingHeight * 0.65);
            
            questionImage.style.maxHeight = imageMaxHeight + 'px';
            questionImage.style.minHeight = '0';
            
            const imgElement = questionImage.querySelector('img');
            if (imgElement) {
                imgElement.style.maxHeight = (imageMaxHeight - 10) + 'px';
            }
            
            answersContainer.style.minHeight = answersMinHeight + 'px';
            answersContainer.style.maxHeight = answersMinHeight + 'px';
            
        } else if (answersContainer) {
            // Sans image : tout l'espace pour les réponses
            answersContainer.style.minHeight = Math.max(150, remainingHeight - 20) + 'px';
            answersContainer.style.maxHeight = (remainingHeight - 20) + 'px';
        }
        
        // ÉTAPE 4 : Ajuster les boutons de réponse pour qu'ils se partagent l'espace
        const answerBtns = document.querySelectorAll('.answer-btn');
        if (answerBtns.length > 0 && answersContainer) {
            const containerHeight = parseFloat(answersContainer.style.maxHeight) || answersContainer.offsetHeight;
            const gap = 8; // gap entre boutons
            const totalGaps = (answerBtns.length - 1) * gap;
            const btnHeight = Math.max(40, (containerHeight - totalGaps) / answerBtns.length);
            
            answerBtns.forEach(btn => {
                btn.style.height = btnHeight + 'px';
                btn.style.minHeight = btnHeight + 'px';
                btn.style.maxHeight = btnHeight + 'px';
                
                // Ajuster la taille de police si le texte est long
                const btnText = btn.textContent.trim();
                if (btnText.length > 50) {
                    btn.style.fontSize = '14px';
                } else if (btnText.length > 30) {
                    btn.style.fontSize = '16px';
                }
            });
        }
        
        // ÉTAPE 5 : S'assurer que le conteneur principal ne déborde pas
        questionContent.style.overflow = 'hidden';
        
        console.log('📐 Layout ajusté:', {
            viewport: viewportHeight,
            available: availableHeight,
            text: textHeight,
            remaining: remainingHeight
        });
    }
    
    // Ré-ajuster lors du redimensionnement
    window.addEventListener('resize', () => {
        if (document.querySelector('.question-screen')) {
            adjustQuestionLayout();
        }
    });
    
    // Ré-ajuster lors du changement d'orientation (mobile)
    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            if (document.querySelector('.question-screen')) {
                adjustQuestionLayout();
            }
        }, 100);
    });

    // ========================================
    // PAGE DE SÉLECTION (Collège + Animal)
    // ========================================
    
    async function showStudentJoinPage(playCode, quizName, totalQuestions = 0) {
        const gameContainer = document.querySelector('.game-container');
        
        // Réinitialiser la sélection d'animal
        selectedAnimal = null;
        
        // Initialiser la session élève avec le playCode et totalQuestions
        initStudentSession(playCode, { name: quizName, totalQuestions: totalQuestions });
        
        // Générer ou récupérer un identifiant unique pour ce poste
        // Cet identifiant persiste entre les onglets et les rafraîchissements
        let deviceId = null;
        try {
            deviceId = localStorage.getItem('qwest_device_id');
            if (!deviceId) {
                // Générer un nouvel identifiant unique
                deviceId = 'dev_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
                localStorage.setItem('qwest_device_id', deviceId);
            }
        } catch (e) {
            // localStorage non disponible, on continue sans
            console.log('⚠️ localStorage non disponible');
        }
        
        // Obtenir 3 animaux UNIQUES depuis le serveur
        let animals = [];
        try {
            let url = `php/api.php?action=get_animals&code=${playCode}`;
            if (deviceId) {
                url += `&deviceId=${encodeURIComponent(deviceId)}`;
            }
            const response = await fetch(url);
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
                        <p class="animal-info">Clique sur ton avatar pour rejoindre 🎮</p>
                    </div>
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
            // Cliquer sur un animal rejoint directement la partie
            document.querySelectorAll('.animal-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const animal = this.getAttribute('data-animal');
                    selectAnimalAndJoin(animal, this);
                });
            });
        }, 0);
    }

    let selectedAnimal = null;

    // Nouvelle fonction : sélectionner l'animal ET rejoindre la partie directement
    async function selectAnimalAndJoin(animal, btnElement) {
        // Éviter les double-clics
        if (selectedAnimal !== null) return;
        
        selectedAnimal = animal;
        
        // Feedback visuel immédiat
        btnElement.classList.add('selected');
        btnElement.innerHTML = '⏳ Connexion...';
        
        // Désactiver tous les boutons
        document.querySelectorAll('.animal-btn').forEach(btn => {
            btn.disabled = true;
            btn.style.pointerEvents = 'none';
        });
        
        // Enregistrer les infos (sans collège)
        setPlayerInfo('', animal);
        
        // Rejoindre la session
        const success = await joinSession();
        
        if (success) {
            // Afficher la salle d'attente
            showWaitingRoom();
        } else {
            // Réactiver les boutons en cas d'échec
            selectedAnimal = null;
            btnElement.classList.remove('selected');
            btnElement.innerHTML = animal;
            document.querySelectorAll('.animal-btn').forEach(btn => {
                btn.disabled = false;
                btn.style.pointerEvents = 'auto';
            });
        }
    }

    // Garder selectAnimal pour compatibilité mais ne plus l'utiliser
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
        
        // IMPORTANT : Pour le calcul des POINTS, on utilise TOUJOURS l'heure LOCALE
        // Cela garantit que le temps de réponse est mesuré depuis le moment où
        // l'élève VOIT la question, pas depuis le lancement côté serveur.
        // Ainsi, un délai réseau ne pénalise pas les élèves.
        const localStartTime = Date.now();
        questionStartTime = localStartTime;
        
        // Pour le TIMER visuel : utiliser le startTime serveur si disponible
        // Cela permet d'afficher le temps restant correct lors d'une reconnexion
        if (data.startTime) {
            serverQuestionStartTime = data.startTime * 1000;
            const elapsedOnServer = Math.round((localStartTime - serverQuestionStartTime) / 1000);
            console.log('⏱️ startTime serveur:', new Date(serverQuestionStartTime).toISOString());
            console.log('⏱️ Temps déjà écoulé côté serveur:', elapsedOnServer + 's');
        } else {
            serverQuestionStartTime = localStartTime;
        }
        
        console.log('⏱️ Heure locale (pour calcul points):', new Date(localStartTime).toISOString());
        
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
        
        // AJUSTEMENT DYNAMIQUE : S'assurer que tout est visible sans scroll
        requestAnimationFrame(() => {
            adjustQuestionLayout();
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
            
            // Re-ajuster après les listeners (au cas où)
            adjustQuestionLayout();
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
        
        // Pour le timer VISUEL : utiliser le temps serveur (important pour reconnexion)
        // Cela affiche le temps restant réel de la question
        const elapsedSeconds = Math.floor((Date.now() - serverQuestionStartTime) / 1000);
        const remainingTime = Math.max(0, duration - elapsedSeconds);
        
        console.log(`⏱️ Timer visuel: durée=${duration}s, écoulé=${elapsedSeconds}s, restant=${remainingTime}s`);
        
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
        
        // NOUVEAU : Démarrer le watchdog anti-blocage
        // Calculer le temps de fin théorique de la question
        if (currentQuestionData && currentQuestionData.question) {
            const questionTime = currentQuestionData.question.time || 30;
            const expectedEndTime = questionStartTime + (questionTime * 1000);
            
            console.log('🐕 ÉLÈVE: Démarrage watchdog', {
                questionIndex: SESSION_STATE.currentQuestion,
                questionTime,
                expectedEndTime: new Date(expectedEndTime).toISOString()
            });
            
            // Démarrer le watchdog pour vérifier si on reste bloqué
            if (window.startWatchdog) {
                window.startWatchdog(SESSION_STATE.currentQuestion, expectedEndTime);
            }
        }
        
        // Fallback : Détection de blocage prolongé (20 secondes, réduit de 30)
        const stuckTimeout = setTimeout(() => {
            const warning = document.getElementById('stuck-warning');
            if (warning && warning.style.display === 'none') {
                warning.style.display = 'block';
                console.warn('⚠️ ÉLÈVE: Bloqué depuis 20s sur "Réponse enregistrée"');
            }
        }, 20000);
        
        // Nettoyer le timeout si on quitte cette page
        const observer = new MutationObserver(() => {
            if (!document.getElementById('answers-container')) {
                clearTimeout(stuckTimeout);
                if (window.stopWatchdog) {
                    window.stopWatchdog();
                }
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
        
        // NOUVEAU : Arrêter le watchdog, on a reçu les résultats
        if (window.stopWatchdog) {
            window.stopWatchdog();
            console.log('🐕 ÉLÈVE: Watchdog arrêté (résultats reçus)');
        }
        
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
