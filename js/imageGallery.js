// ============================================
// MODULE: IMAGE GALLERY (Wikimedia Commons)
// Description: Gestion de la galerie d'images avec recherche Wikimedia Commons
// URLs PERMANENTES - ILLIMITÉ - Parfait pour l'éducation !
// ============================================

(function() {
    'use strict';

    // ========================================
    // CONFIGURATION
    // ========================================
    
    const WIKIMEDIA_CONFIG = {
        apiUrl: 'https://commons.wikimedia.org/w/api.php',
        perPage: 12,
        thumbSize: 400 // Taille des miniatures
    };

    let galleryState = {
        currentPage: 1,
        currentQuery: '',
        totalResults: 0,
        offset: 0,
        selectedImageUrl: null,
        onSelectCallback: null,
        cachedResults: [] // Cache pour la pagination
    };

    // ========================================
    // OUVRIR LA GALERIE
    // ========================================
    
    function openImageGallery(onSelectCallback) {
        galleryState.onSelectCallback = onSelectCallback;
        galleryState.currentPage = 1;
        galleryState.currentQuery = '';
        galleryState.offset = 0;
        galleryState.cachedResults = [];
        
        const modal = document.getElementById('image-gallery-modal');
        if (modal) {
            modal.classList.add('active');
            // Charger les images populaires par défaut
            searchImages('education science');
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
            query = 'education science';
        }
        
        // Si nouvelle recherche, réinitialiser
        if (query !== galleryState.currentQuery) {
            galleryState.currentPage = 1;
            galleryState.offset = 0;
            galleryState.cachedResults = [];
        }
        
        galleryState.currentQuery = query;
        galleryState.currentPage = page;
        galleryState.offset = (page - 1) * WIKIMEDIA_CONFIG.perPage;
        
        // Afficher loading
        resultsContainer.innerHTML = '<div class="gallery-loading">🔍 Recherche en cours...</div>';
        paginationContainer.innerHTML = '';
        
        try {
            // Utiliser l'API de recherche de Wikimedia Commons
            // On cherche dans les images (File:) avec la query
            const url = `${WIKIMEDIA_CONFIG.apiUrl}?` + new URLSearchParams({
                action: 'query',
                format: 'json',
                generator: 'search',
                gsrsearch: `File: ${query}`,
                gsrnamespace: '6', // Namespace 6 = File
                gsrlimit: WIKIMEDIA_CONFIG.perPage,
                gsroffset: galleryState.offset,
                prop: 'imageinfo|info',
                iiprop: 'url|size|extmetadata',
                iiurlwidth: WIKIMEDIA_CONFIG.thumbSize,
                inprop: 'url',
                origin: '*'
            });
            
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.query && data.query.pages) {
                const pages = Object.values(data.query.pages);
                
                // Filtrer les pages qui ont des imageinfo valides
                const validImages = pages.filter(page => 
                    page.imageinfo && 
                    page.imageinfo[0] && 
                    page.imageinfo[0].thumburl &&
                    page.imageinfo[0].url
                );
                
                if (validImages.length > 0) {
                    galleryState.totalResults = data.query.searchinfo?.totalhits || validImages.length;
                    renderGalleryResults(validImages);
                    renderPagination();
                } else {
                    resultsContainer.innerHTML = '<div class="gallery-empty">😕 Aucune image trouvée. Essayez un autre mot-clé.</div>';
                }
            } else {
                resultsContainer.innerHTML = '<div class="gallery-empty">😕 Aucune image trouvée. Essayez un autre mot-clé.</div>';
            }
            
        } catch (error) {
            console.error('Erreur recherche Wikimedia:', error);
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
            const imageInfo = image.imageinfo[0];
            
            // URL permanente de l'image en taille réelle
            const imageUrl = imageInfo.url;
            
            // URL de la miniature pour l'affichage
            const thumbUrl = imageInfo.thumburl;
            
            // Récupérer le titre et l'auteur depuis les métadonnées
            const metadata = imageInfo.extmetadata || {};
            const title = image.title.replace('File:', '').replace(/\.\w+$/, '').replace(/_/g, ' ');
            const artist = metadata.Artist?.value ? 
                stripHtmlTags(metadata.Artist.value).substring(0, 30) : 
                'Wikimedia Commons';
            
            // Échapper correctement l'URL pour éviter les problèmes avec les apostrophes
            const escapedUrl = imageUrl.replace(/'/g, "\\'");
            const escapedTitle = escapeHtml(title).replace(/'/g, "\\'");
            
            html += `
                <div class="gallery-item" onclick="selectImage('${escapedUrl}', '${escapedTitle}')">
                    <img src="${thumbUrl}" alt="${escapeHtml(title)}" loading="lazy">
                    <div class="gallery-item-overlay">
                        <button class="btn-select-image">✓ Sélectionner</button>
                    </div>
                    <div class="gallery-item-info">
                        <span class="gallery-item-author">📷 ${escapeHtml(artist)}</span>
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
        const currentPage = galleryState.currentPage;
        const hasMoreResults = galleryState.totalResults > (currentPage * WIKIMEDIA_CONFIG.perPage);
        
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
        html += `<span class="pagination-info">Page ${currentPage}</span>`;
        
        // Bouton suivant
        if (hasMoreResults && currentPage < 20) {
            html += `<button class="btn-pagination" onclick="searchImages('${escapedQuery}', ${currentPage + 1})">Suivant →</button>`;
        } else {
            html += `<button class="btn-pagination" disabled>Suivant →</button>`;
        }
        
        html += '</div>';
        
        const resultText = galleryState.totalResults > 0 ? 
            `📊 ${galleryState.totalResults} images trouvées` : 
            '📊 Images disponibles';
        html += `<div class="pagination-results">${resultText}</div>`;
        
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
    
    function stripHtmlTags(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
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
