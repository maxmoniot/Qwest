// ============================================
// MODULE: IMAGE GALLERY (Pixabay)
// Description: Gestion de la galerie d'images avec recherche Pixabay
// ============================================

(function() {
    'use strict';

    // ========================================
    // CONFIGURATION
    // ========================================
    
    const PIXABAY_CONFIG = {
        apiKey: '53901925-e66128e69e09c6bd7a19784bb',
        apiUrl: 'https://pixabay.com/api/',
        perPage: 12,
        imageType: 'photo,illustration',
        safesearch: true
    };

    let galleryState = {
        currentPage: 1,
        currentQuery: '',
        totalHits: 0,
        selectedImageUrl: null,
        onSelectCallback: null
    };

    // ========================================
    // OUVRIR LA GALERIE
    // ========================================
    
    function openImageGallery(onSelectCallback) {
        galleryState.onSelectCallback = onSelectCallback;
        galleryState.currentPage = 1;
        galleryState.currentQuery = '';
        
        const modal = document.getElementById('image-gallery-modal');
        if (modal) {
            modal.classList.add('active');
            // Charger les images populaires par défaut
            searchImages('nature landscape');
        }
    }

    function closeImageGallery() {
        const modal = document.getElementById('image-gallery-modal');
        if (modal) {
            modal.classList.remove('active');
        }
        galleryState.selectedImageUrl = null;
    }

    // ========================================
    // RECHERCHE D'IMAGES
    // ========================================
    
    async function searchImages(query = '', page = 1) {
        const searchInput = document.getElementById('gallery-search-input');
        const resultsContainer = document.getElementById('gallery-results');
        const paginationContainer = document.getElementById('gallery-pagination');
        
        // Si query vide, prendre la valeur de l'input
        if (!query && searchInput) {
            query = searchInput.value.trim();
        }
        
        // Si toujours vide, recherche par défaut
        if (!query) {
            query = 'education learning';
        }
        
        galleryState.currentQuery = query;
        galleryState.currentPage = page;
        
        // Afficher loading
        resultsContainer.innerHTML = '<div class="gallery-loading">🔍 Recherche en cours...</div>';
        paginationContainer.innerHTML = '';
        
        try {
            const url = `${PIXABAY_CONFIG.apiUrl}?key=${PIXABAY_CONFIG.apiKey}&q=${encodeURIComponent(query)}&page=${page}&per_page=${PIXABAY_CONFIG.perPage}&image_type=${PIXABAY_CONFIG.imageType}&safesearch=${PIXABAY_CONFIG.safesearch}&lang=fr`;
            
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.hits && data.hits.length > 0) {
                galleryState.totalHits = data.totalHits;
                renderGalleryResults(data.hits);
                renderPagination();
            } else {
                resultsContainer.innerHTML = '<div class="gallery-empty">😕 Aucune image trouvée. Essayez un autre mot-clé.</div>';
            }
            
        } catch (error) {
            console.error('Erreur recherche Pixabay:', error);
            resultsContainer.innerHTML = '<div class="gallery-error">❌ Erreur de connexion. Vérifiez votre connexion internet.</div>';
        }
    }

    // ========================================
    // AFFICHAGE DES RÉSULTATS
    // ========================================
    
    function renderGalleryResults(images) {
        const container = document.getElementById('gallery-results');
        
        let html = '<div class="gallery-grid">';
        
        images.forEach(image => {
            // Échapper correctement l'URL pour éviter les problèmes avec les apostrophes
            const escapedUrl = image.webformatURL.replace(/'/g, "\\'");
            const escapedTags = escapeHtml(image.tags).replace(/'/g, "\\'");
            
            html += `
                <div class="gallery-item" onclick="selectImage('${escapedUrl}', '${escapedTags}')">
                    <img src="${image.previewURL}" alt="${escapeHtml(image.tags)}" loading="lazy">
                    <div class="gallery-item-overlay">
                        <button class="btn-select-image">✓ Sélectionner</button>
                    </div>
                    <div class="gallery-item-info">
                        <span class="gallery-item-author">📷 ${escapeHtml(image.user)}</span>
                    </div>
                </div>
            `;
        });
        
        html += '</div>';
        container.innerHTML = html;
    }

    // ========================================
    // PAGINATION
    // ========================================
    
    function renderPagination() {
        const container = document.getElementById('gallery-pagination');
        const totalPages = Math.ceil(galleryState.totalHits / PIXABAY_CONFIG.perPage);
        const currentPage = galleryState.currentPage;
        
        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }
        
        // Échapper la query pour éviter les problèmes avec les apostrophes
        const escapedQuery = galleryState.currentQuery.replace(/'/g, "\\'");
        
        let html = '<div class="pagination-buttons">';
        
        // Bouton précédent
        if (currentPage > 1) {
            html += `<button class="btn-pagination" onclick="searchImages('${escapedQuery}', ${currentPage - 1})">← Précédent</button>`;
        } else {
            html += `<button class="btn-pagination" disabled>← Précédent</button>`;
        }
        
        // Info page
        html += `<span class="pagination-info">Page ${currentPage} / ${Math.min(totalPages, 10)}</span>`;
        
        // Bouton suivant (limiter à 10 pages pour éviter abus API)
        if (currentPage < totalPages && currentPage < 10) {
            html += `<button class="btn-pagination" onclick="searchImages('${escapedQuery}', ${currentPage + 1})">Suivant →</button>`;
        } else {
            html += `<button class="btn-pagination" disabled>Suivant →</button>`;
        }
        
        html += '</div>';
        
        html += `<div class="pagination-results">📊 ${galleryState.totalHits} images trouvées</div>`;
        
        container.innerHTML = html;
    }

    // ========================================
    // SÉLECTION D'IMAGE
    // ========================================
    
    function selectImage(imageUrl, tags) {
        galleryState.selectedImageUrl = imageUrl;
        
        // Appeler le callback avec l'URL
        if (galleryState.onSelectCallback) {
            galleryState.onSelectCallback(imageUrl);
        }
        
        closeImageGallery();
    }

    // ========================================
    // GESTION DE LA RECHERCHE
    // ========================================
    
    function handleSearchInput(event) {
        if (event.key === 'Enter') {
            searchImages();
        }
    }

    function handleSearchButton() {
        searchImages();
    }

    // ========================================
    // HELPERS
    // ========================================
    
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ========================================
    // SAISIE D'URL MANUELLE
    // ========================================
    
    function openUrlImagePrompt() {
        const url = prompt('🔗 Collez l\'URL de votre image ici :');
        
        if (!url) return; // Annulé
        
        // Vérifier que l'URL est valide
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            alert('❌ L\'URL doit commencer par http:// ou https://');
            return;
        }
        
        // Vérifier que c'est bien une image (extension)
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
        const hasImageExtension = imageExtensions.some(ext => url.toLowerCase().includes(ext));
        
        if (!hasImageExtension) {
            // Demander confirmation si pas d'extension image reconnue
            const confirm = window.confirm('⚠️ L\'URL ne semble pas pointer vers une image. Voulez-vous quand même l\'utiliser ?');
            if (!confirm) return;
        }
        
        // Sélectionner l'image avec l'URL fournie
        selectImage(url, 'Image personnalisée');
    }

    // ========================================
    // EXPORT VERS GLOBAL
    // ========================================
    
    window.openImageGallery = openImageGallery;
    window.closeImageGallery = closeImageGallery;
    window.searchImages = searchImages;
    window.selectImage = selectImage;
    window.handleSearchInput = handleSearchInput;
    window.handleSearchButton = handleSearchButton;
    window.openUrlImagePrompt = openUrlImagePrompt;

})();
