// ===== MAIN APPLICATION SCRIPT WITH PROFILE INTEGRATION =====
// Dependencies: firebase-config.js, firebase-manager.js, and profile-managers.js must be loaded first

// ===== STRIPE CONFIGURATION =====
const STRIPE_CONFIG = {
    publishableKey: 'pk_test_51S5YU8FKyDLT77ug2RZh3OVCAzDsHVPZIvyBWxjuTcylKHLcza1XhFTjEzpWbdgilo5fpTl16ivKardNXM23c6AI00eknKjdiV'
};

// ===== GLOBAL STATE =====
let cart = [];
let currentFilter = 'all';
let stripe = null;
let firebaseManager = null;
let profileUI = null;
let products = []; // This will be populated from Firebase
let currentDetailProduct = null;
        let selectedSize = '';
        let detailQuantity = 1;
        let isInWishlist = false;
// ===== PROFILE-AWARE CART MANAGEMENT =====
class ProfileAwareCartManager {
    constructor(firebaseManager) {
        this.firebaseManager = firebaseManager;
        this.localCart = [];
    }

    async initialize() {
        await this.syncWithProfile();
    }

    async syncWithProfile() {
        if (!this.firebaseManager || !this.firebaseManager.currentProfile) return;
        
        const profileCart = this.firebaseManager.currentProfile.shopping.cart.items;
        
        this.localCart = profileCart.map(item => {
            const product = products.find(p => p.id === item.product_id);
            if (!product) return null;
            
            return {
                ...product,
                quantity: item.quantity
            };
        }).filter(Boolean);
        
        cart = this.localCart;
    }

    async addToCart(productId, quantity = 1) {
        if (this.firebaseManager) {
            await this.firebaseManager.addToCart(productId, quantity);
        }
        
        const product = products.find(p => p.id === productId);
        if (!product) return false;

        const existingItem = this.localCart.find(item => item.id === productId);
        if (existingItem) {
            existingItem.quantity += quantity;
        } else {
            this.localCart.push({ ...product, quantity });
        }
        
        cart = this.localCart;
        return true;
    }

    async removeFromCart(productId) {
        if (this.firebaseManager) {
            await this.firebaseManager.removeFromCart(productId);
        }
        
        this.localCart = this.localCart.filter(item => item.id !== productId);
        cart = this.localCart;
    }

    async updateQuantity(productId, quantity) {
        if (this.firebaseManager) {
            await this.firebaseManager.updateCartQuantity(productId, quantity);
        }
        
        const item = this.localCart.find(item => item.id === productId);
        if (item) {
            if (quantity <= 0) {
                await this.removeFromCart(productId);
            } else {
                item.quantity = quantity;
                cart = this.localCart;
            }
        }
    }

    async clearCart() {
        if (this.firebaseManager) {
            await this.firebaseManager.clearCart();
        }
        
        this.localCart = [];
        cart = [];
    }

    getCart() {
        return this.localCart;
    }

    getCartCount() {
        return this.localCart.reduce((sum, item) => sum + item.quantity, 0);
    }

    getCartTotal() {
        return this.localCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    }
}

// ===== STRIPE INTEGRATION =====
class StripeIntegration {
    constructor() {
        this.publishableKey = STRIPE_CONFIG.publishableKey;
        this.stripe = null;
        this.elements = null;
        this.isLocalDevelopment = window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    }

    async initialize() {
        try {
            if (!window.Stripe) {
                await this.loadStripeJS();
            }
            
            this.stripe = window.Stripe(this.publishableKey);
            console.log('Stripe initialized successfully');
            return this.stripe;
        } catch (error) {
            console.error('Failed to initialize Stripe:', error);
            if (this.isLocalDevelopment) {
                console.log('Running locally - some Stripe features may be limited');
            }
            return null;
        }
    }

    async loadStripeJS() {
        return new Promise((resolve, reject) => {
            if (window.Stripe) {
                resolve();
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://js.stripe.com/v3/';
            script.onload = resolve;
            script.onerror = (error) => {
                if (this.isLocalDevelopment) {
                    console.log('Stripe.js failed to load - this is expected when running locally');
                    resolve();
                } else {
                    reject(error);
                }
            };
            document.head.appendChild(script);
        });
    }

    async createCheckoutSession(items, customerInfo = {}) {
        if (this.isLocalDevelopment) {
            console.log('Local development mode - simulating Stripe checkout');
            console.log('Items to checkout:', items);
            
            await this.logCheckoutToFirebase(items, customerInfo);
            
            showNotification('Local development mode - checkout simulated');
            
            setTimeout(async () => {
                if (window.cartManager) {
                    await window.cartManager.clearCart();
                    updateCartCount();
                    updateCartDisplay();
                    closeCart();
                }
            }, 2000);
            
            return;
        }

        if (!this.stripe) {
            throw new Error('Stripe not initialized');
        }

        try {
            await this.logCheckoutToFirebase(items, customerInfo);

            const lineItems = items.map(item => ({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: item.name,
                        description: item.description,
                        images: [item.image],
                        metadata: {
                            product_id: item.id,
                            sku: item.sku,
                            category: item.category
                        }
                    },
                    unit_amount: Math.round(item.price * 100)
                },
                quantity: item.quantity
            }));

            const { error } = await this.stripe.redirectToCheckout({
                lineItems,
                mode: 'payment',
                successUrl: `${window.location.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
                cancelUrl: `${window.location.origin}/cart`,
                customerEmail: customerInfo.email,
                shippingAddressCollection: {
                    allowedCountries: ['US', 'CA']
                },
                metadata: {
                    order_source: 'all_seasons_sprouts',
                    customer_ip: await this.getClientIP(),
                    profile_id: firebaseManager?.currentProfile?.id
                }
            });

            if (error) {
                throw error;
            }

        } catch (error) {
            console.error('Stripe checkout error:', error);
            await firebaseManager.logEvent('checkout_error', {
                error: error.message,
                cart_items: items.length,
                cart_value: items.reduce((sum, item) => sum + (item.price * item.quantity), 0)
            });
            throw error;
        }
    }

    async logCheckoutToFirebase(items, customerInfo) {
        const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const shippingCost = this.calculateShipping(items);
        const tax = this.calculateTax(subtotal);
        const total = subtotal + shippingCost + tax;

        const orderData = {
            customer: customerInfo,
            items: items.map(item => ({
                product_id: item.id,
                name: item.name,
                sku: item.sku,
                price: item.price,
                quantity: item.quantity,
                total: item.price * item.quantity
            })),
            totals: {
                subtotal,
                shipping: shippingCost,
                tax,
                total
            },
            payment_method: 'stripe',
            order_source: 'website',
            order_id: 'order_' + Date.now()
        };

        await firebaseManager.logOrder(orderData);
    }

    calculateShipping(items) {
        const totalWeight = items.reduce((sum, item) => sum + (item.weight * item.quantity), 0);

        if (totalWeight < 1) return 5.99;
        if (totalWeight < 3) return 8.99;
        if (totalWeight < 5) return 12.99;
        return 15.99;
    }

    calculateTax(subtotal) {
        return subtotal * 0.085;
    }

    async getClientIP() {
        try {
            const response = await fetch('https://api.ipify.org?format=json');
            const data = await response.json();
            return data.ip;
        } catch (error) {
            return 'unknown';
        }
    }
}

// ===== INVENTORY MANAGEMENT =====
class InventoryManager {
    constructor() {
        this.lowStockThreshold = INVENTORY_CONFIG.lowStockThreshold;
        this.ownerEmail = INVENTORY_CONFIG.ownerEmail;
    }

    getStockStatus(product) {
        if (product.preorder && product.stock === 0) return 'preorder';
        if (product.stock === 0) return 'out-of-stock';
        if (product.stock <= this.lowStockThreshold) return 'low-stock';
        return 'in-stock';
    }

    getStockBadgeInfo(product) {
        const status = this.getStockStatus(product);
        const badges = {
            'in-stock': { text: 'In Stock', class: 'in-stock' },
            'low-stock': { text: `Only ${product.stock} left`, class: 'low-stock' },
            'out-of-stock': { text: 'Sold Out', class: 'out-of-stock' },
            'preorder': { text: 'Preorder', class: 'preorder' }
        };
        return badges[status];
    }

    async updateStock(productId, quantitySold, reason = 'sale') {
        const product = products.find(p => p.id === productId);
        if (!product) return false;

        const previousStock = product.stock;
        const wasLowStock = previousStock <= this.lowStockThreshold;
        const wasInStock = previousStock > 0;

        const newStock = Math.max(0, product.stock - quantitySold);
        product.stock = newStock; // Update local copy

        // Update in Firebase
        if (firebaseManager) {
            await firebaseManager.updateProductStock(productId, newStock, reason);
        }

        if (newStock === 0 && wasInStock) {
            await firebaseManager.sendStockAlert(productId, 'sold_out');
        } else if (newStock <= this.lowStockThreshold && !wasLowStock && newStock > 0) {
            await firebaseManager.sendStockAlert(productId, 'low_stock');
        }

        console.log(`Inventory updated: ${product.name} - ${newStock} remaining`);
        return true;
    }
}

// ===== INITIALIZE MANAGERS =====
const stripeIntegration = new StripeIntegration();
const inventoryManager = new InventoryManager();
let cartManager = null;

// ===== DOM ELEMENTS =====
const loadingScreen = document.getElementById('loadingScreen');
const header = document.getElementById('header');
const cartBtn = document.getElementById('cartBtn');
const cartCount = document.getElementById('cartCount');
const cartSidebar = document.getElementById('cartSidebar');
const cartOverlay = document.getElementById('cartOverlay');
const cartClose = document.getElementById('cartClose');
const cartItems = document.getElementById('cartItems');
const cartTotal = document.getElementById('cartTotal');
const checkoutBtn = document.getElementById('checkoutBtn');
const productsGrid = document.getElementById('productsGrid');
const filterTabs = document.querySelectorAll('.filter-tab');
const notification = document.getElementById('notification');
const notificationText = document.getElementById('notificationText');

// ===== PRODUCT LOADING & RENDERING =====
async function loadProducts() {
    try {
        showSkeletonLoading();
        
        if (firebaseManager && firebaseManager.isInitialized) {
            // Load products from Firebase and update global products array
            products = await firebaseManager.getProducts();
            
            if (products.length === 0) {
                console.warn('No products found in Firebase');
                showEmptyState();
                return;
            }
        } else {
            console.warn('Firebase not initialized, using fallback');
            products = firebaseManager ? await firebaseManager.getFallbackProducts() : [];
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        renderProducts();
        
    } catch (error) {
        console.error('Failed to load products:', error);
        showErrorState();
    }
}

function showErrorState() {
    productsGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 2rem; color: #dc2626;">
            <h3 style="margin-bottom: 1rem;">Failed to load products</h3>
            <p style="margin-bottom: 2rem;">Please check your internet connection and try again.</p>
            <button onclick="loadProducts()" style="background: var(--color-primary); color: white; padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer;">
                Retry Loading
            </button>
        </div>
    `;
}

function renderProducts(productsToRender = null) {
    const filteredProducts = productsToRender || getFilteredProducts();
    
    productsGrid.innerHTML = '';
    
    if (filteredProducts.length === 0) {
        showEmptyState();
        return;
    }
    
    filteredProducts.forEach((product, index) => {
        const productCard = createProductCard(product);
        productCard.style.opacity = '0';
        productCard.style.transform = 'translateY(20px)';
        productsGrid.appendChild(productCard);
        
        setTimeout(() => {
            productCard.style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
            productCard.style.opacity = '1';
            productCard.style.transform = 'translateY(0)';
        }, index * 100);
    });
}

function getFilteredProducts() {
    if (currentFilter === 'all') {
        return products;
    }
    return products.filter(product => product.category === currentFilter);
}

function createProductCard(product) {
    const card = document.createElement('div');
    card.className = 'product-card';
    
    const stockInfo = inventoryManager.getStockBadgeInfo(product);
    const isOutOfStock = product.stock === 0 && !product.preorder;
    
    card.innerHTML = `
        <div class="product-image-container">
            <img src="${product.image}" alt="${product.name}" class="product-image" loading="lazy" 
     onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAwIiBoZWlnaHQ9IjgwMCIgdmlld0JveD0iMCAwIDYwMCA4MDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSI2MDAiIGhlaWdodD0iODAwIiBmaWxsPSIjRjNGNEY2Ii8+Cjx0ZXh0IHg9IjMwMCIgeT0iNDAwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjOUNBM0FGIiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSIyNCI+SW1hZ2UgTm90IEZvdW5kPC90ZXh0Pgo8L3N2Zz4K'">
            <div class="stock-badge ${stockInfo.class}">${stockInfo.text}</div>
            <button class="quick-add-btn" onclick="addToCart('${product.id}')" ${isOutOfStock ? 'disabled' : ''}>
                ${getAddToCartText(product)}
            </button>
            <button class="wishlist-btn" onclick="addToWishlist('${product.id}')" title="Add to Wishlist">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
            </button>
        </div>
        <div class="product-info">
            <div class="product-category">${getCategoryDisplayName(product.category)}</div>
            <h3 class="product-title">${product.name}</h3>
            <div class="product-price">$${product.price.toFixed(2)}</div>
            ${product.sku ? `<div class="product-sku">SKU: ${product.sku}</div>` : ''}
        </div>
    `;

    card.addEventListener('click', async (e) => {
    if (!e.target.closest('.quick-add-btn') && !e.target.closest('.wishlist-btn')) {
        // Show product detail modal
        showProductDetail(product.id);
    }
});
    
    return card;
}

function getAddToCartText(product) {
    if (product.stock === 0 && !product.preorder) return 'Sold Out';
    if (product.preorder) return 'Preorder';
    return 'Add to Cart';
}

function getCategoryDisplayName(category) {
    const names = {
        'boys': 'Boys',
        'girls': 'Girls',
        'women': 'Women\'s Jewelry',
        'accessories': 'Accessories'
    };
    return names[category] || category;
}

function showSkeletonLoading() {
    productsGrid.innerHTML = '';
    
    for (let i = 0; i < 12; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton-product';
        skeleton.innerHTML = `
            <div class="skeleton-image skeleton"></div>
            <div class="skeleton-category skeleton"></div>
            <div class="skeleton-title skeleton"></div>
            <div class="skeleton-price skeleton"></div>
        `;
        productsGrid.appendChild(skeleton);
    }
}

function showEmptyState() {
    productsGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 2rem; color: #999;">
            <h3 style="margin-bottom: 1rem;">No products found</h3>
            <p>Try adjusting your filter selection.</p>
        </div>
    `;
}

// ===== FILTER HANDLING =====
async function handleFilterChange(e) {
    const newFilter = e.target.dataset.filter;
    
    filterTabs.forEach(tab => tab.classList.remove('active'));
    e.target.classList.add('active');
    
    currentFilter = newFilter;
    renderProducts();
    
    if (firebaseManager) {
        await firebaseManager.logEvent('filter_used', {
            filter: newFilter,
            products_shown: getFilteredProducts().length
        });
    }
}

// ===== CART FUNCTIONALITY =====
async function addToCart(productId) {
    const product = products.find(p => p.id === productId);
    if (!product || (product.stock === 0 && !product.preorder)) {
        return;
    }
    
    const button = event.target;
    const originalText = button.textContent;
    
    button.style.background = '#2d5a27';
    button.textContent = 'Added!';
    button.disabled = true;
    
    try {
        if (!product.preorder && firebaseManager) {
            await inventoryManager.updateStock(productId, 1);
        }
        
        await cartManager.addToCart(productId, 1);
        
        if (firebaseManager) {
            await firebaseManager.logEvent('item_added_to_cart', {
                product: {
                    id: product.id,
                    name: product.name,
                    sku: product.sku,
                    price: product.price,
                    category: product.category
                },
                cart_total_items: cartManager.getCartCount(),
                cart_total_value: cartManager.getCartTotal()
            });
        }
        
        updateCartCount();
        updateCartDisplay();
        showNotification(`${product.name} added to cart`);
        
        setTimeout(() => {
            button.style.background = '';
            button.textContent = originalText;
            button.disabled = false;
            loadProducts(); // Reload to show updated stock
        }, 1500);
        
    } catch (error) {
        console.error('Failed to add item to cart:', error);
        showNotification('Failed to add item to cart', 'error');
        
        button.style.background = '';
        button.textContent = originalText;
        button.disabled = false;
    }
}

async function addToWishlist(productId) {
    const product = products.find(p => p.id === productId);
    if (!product || !firebaseManager) return;

    try {
        await firebaseManager.addToWishlist(productId, {
            name: product.name,
            price: product.price,
            category: product.category,
            image: product.image
        });

        showNotification(`${product.name} added to wishlist`);
        
        const wishlistBtn = event.target.closest('.wishlist-btn');
        if (wishlistBtn) {
            wishlistBtn.style.color = '#2d5a27';
        }
    } catch (error) {
        console.error('Failed to add to wishlist:', error);
        showNotification('Failed to add to wishlist', 'error');
    }
}

async function removeFromCart(productId) {
    await cartManager.removeFromCart(productId);
    
    updateCartCount();
    updateCartDisplay();
    
    if (firebaseManager) {
        await firebaseManager.logEvent('item_removed_from_cart', {
            product_id: productId,
            cart_total_items: cartManager.getCartCount(),
            cart_total_value: cartManager.getCartTotal()
        });
    }
}

async function updateQuantity(productId, change) {
    const currentCart = cartManager.getCart();
    const item = currentCart.find(item => item.id === productId);
    if (!item) return;
    
    const newQuantity = item.quantity + change;
    
    if (newQuantity <= 0) {
        await removeFromCart(productId);
    } else {
        await cartManager.updateQuantity(productId, newQuantity);
        updateCartCount();
        updateCartDisplay();
        
        if (firebaseManager) {
            await firebaseManager.logEvent('cart_quantity_updated', {
                product_id: productId,
                old_quantity: item.quantity,
                new_quantity: newQuantity,
                cart_total_items: cartManager.getCartCount(),
                cart_total_value: cartManager.getCartTotal()
            });
        }
    }
}

function updateCartCount() {
    const totalItems = cartManager ? cartManager.getCartCount() : 0;
    cartCount.textContent = totalItems;
    
    if (totalItems > 0) {
        cartCount.classList.add('show');
        checkoutBtn.disabled = false;
    } else {
        cartCount.classList.remove('show');
        checkoutBtn.disabled = true;
    }
}

function updateCartDisplay() {
    const currentCart = cartManager ? cartManager.getCart() : [];
    
    if (currentCart.length === 0) {
        cartItems.innerHTML = `
            <div class="empty-cart">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                    <path d="M9 22C9.55228 22 10 21.5523 10 21C10 20.4477 9.55228 20 9 20C8.44772 20 8 20.4477 8 21C8 21.5523 8.44772 22 9 22Z"></path>
                    <path d="M20 22C20.5523 22 21 21.5523 21 21C21 20.4477 20.5523 20 20 20C19.4477 20 19 20.4477 19 21C19 21.5523 19.4477 22 20 22Z"></path>
                    <path d="M1 1H5L7.68 14.39C7.77144 14.8504 8.02191 15.264 8.38755 15.5583C8.75318 15.8526 9.2107 16.009 9.68 16H19.4C19.8693 16.009 20.3268 15.8526 20.6925 15.5583C21.0581 15.264 21.3086 14.8504 21.4 14.39L23 6H6"></path>
                </svg>
                <h4>Your cart is empty</h4>
                <p>Add some beautiful pieces to get started</p>
            </div>
        `;
        cartTotal.textContent = '$0.00';
        return;
    }
    
    cartItems.innerHTML = '';
    let total = 0;
    
    currentCart.forEach(item => {
        const itemTotal = item.price * item.quantity;
        total += itemTotal;
        
        const cartItem = document.createElement('div');
        cartItem.className = 'cart-item';
        cartItem.innerHTML = `
            <img src="${item.image}" alt="${item.name}" class="cart-item-image">
            <div class="cart-item-details">
                <div class="cart-item-info">
                    <h4>${item.name}</h4>
                    <p>${getCategoryDisplayName(item.category)}</p>
                </div>
                <div class="cart-item-controls">
                    <div class="quantity-controls">
                        <button class="quantity-btn" onclick="updateQuantity('${item.id}', -1)">−</button>
                        <span class="quantity">${item.quantity}</span>
                        <button class="quantity-btn" onclick="updateQuantity('${item.id}', 1)">+</button>
                    </div>
                    <div class="item-price">$${itemTotal.toFixed(2)}</div>
                </div>
                <button class="remove-item" onclick="removeFromCart('${item.id}')">Remove</button>
            </div>
        `;
        cartItems.appendChild(cartItem);
    });
    
    cartTotal.textContent = `$${total.toFixed(2)}`;
}

async function openCart() {
    cartSidebar.classList.add('open');
    cartOverlay.classList.add('show');
    document.body.style.overflow = 'hidden';
    
    if (firebaseManager) {
        await firebaseManager.logEvent('cart_opened', {
            cart_items: cartManager.getCartCount(),
            cart_value: cartManager.getCartTotal()
        });
    }
}

function closeCart() {
    cartSidebar.classList.remove('open');
    cartOverlay.classList.remove('show');
    document.body.style.overflow = '';
}

async function proceedToCheckout() {
    const currentCart = cartManager.getCart();
    if (currentCart.length === 0) return;
    
    try {
        checkoutBtn.textContent = 'Processing...';
        checkoutBtn.disabled = true;
        
        const profile = await firebaseManager.getCurrentProfile();
        const customerInfo = {
            email: profile?.personal_info?.email || null,
            name: profile?.personal_info?.name || null,
            phone: profile?.personal_info?.phone || null,
            ip: await stripeIntegration.getClientIP(),
            user_agent: navigator.userAgent,
            timestamp: new Date().toISOString(),
            profile_id: profile?.id
        };
        
        if (firebaseManager) {
            await firebaseManager.logEvent('checkout_initiated', {
                cart_items: currentCart.length,
                cart_value: cartManager.getCartTotal(),
                customer_info: customerInfo
            });
        }
        
        if (profile?.type === 'guest' && currentCart.length > 0) {
            const shouldShowPrompt = confirm('Want to save your cart and track your order? Create a free account!');
            if (shouldShowPrompt && profileUI) {
                profileUI.showSignupPrompt();
                return;
            }
        }
        
        await stripeIntegration.createCheckoutSession(currentCart, customerInfo);
        
    } catch (error) {
        console.error('Checkout failed:', error);
        showNotification('Checkout failed. Please try again.', 'error');
        
        if (firebaseManager) {
            await firebaseManager.logEvent('checkout_error', {
                error: error.message,
                cart_items: currentCart.length,
                cart_value: cartManager.getCartTotal()
            });
        }
    } finally {
        checkoutBtn.textContent = 'Proceed to Checkout';
        checkoutBtn.disabled = currentCart.length === 0;
    }
}

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

async function initializeApp() {
    try {
        // Initialize Firebase
        firebaseManager = new FirebaseManager();
        await firebaseManager.initialize();
        
        // Initialize cart manager with profile integration
        cartManager = new ProfileAwareCartManager(firebaseManager);
        await cartManager.initialize();
        
        // Initialize Profile UI
        profileUI = new ProfileUI();
        profileUI.initialize(firebaseManager);
        
        // Make available globally
        window.profileUI = profileUI;
        window.firebaseManager = firebaseManager;
        window.cartManager = cartManager;
        
        // Initialize Stripe
        await stripeIntegration.initialize();
        
        // Setup event listeners
        setupEventListeners();
        setupHeaderScroll();
        setupNavigationRouting();
        
        // Load products (THIS IS CRITICAL - must populate products array)
        await loadProducts();
        
        // Update cart display
        updateCartCount();
        updateCartDisplay();
        
        // Hide loading screen
        setTimeout(() => {
            loadingScreen.classList.add('hidden');
        }, 1500);
        
        // Setup remaining features
        scheduleDailyReport();
        
        await firebaseManager.logEvent('app_initialized', {
            user_agent: navigator.userAgent,
            screen_resolution: `${screen.width}x${screen.height}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
        
        await trackUserSession();
        setupSignupPrompts();
        
        console.log('App initialized successfully with profile system');
        
    } catch (error) {
        console.error('App initialization failed:', error);
        showNotification('Failed to initialize app', 'error');
    }
}

// ===== SIGNUP PROMPT TRIGGERS =====
function setupSignupPrompts() {
    let actionsCount = 0;
    let lastPromptTime = localStorage.getItem('lastSignupPrompt');
    const oneDayMs = 24 * 60 * 60 * 1000;
    
    const trackAction = () => {
        actionsCount++;
        
        if (actionsCount >= 5 && 
            firebaseManager?.currentProfile?.type === 'guest' &&
            (!lastPromptTime || Date.now() - parseInt(lastPromptTime) > oneDayMs)) {
            
            setTimeout(() => {
                if (profileUI) {
                    profileUI.showSignupPrompt();
                    localStorage.setItem('lastSignupPrompt', Date.now().toString());
                }
            }, 1000);
            
            actionsCount = 0;
        }
    };
    
    document.addEventListener('click', (e) => {
        if (e.target.closest('.product-card') || 
            e.target.closest('.filter-tab') || 
            e.target.closest('.quick-add-btn')) {
            trackAction();
        }
    });
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
    filterTabs.forEach(tab => {
        tab.addEventListener('click', handleFilterChange);
    });

    cartBtn.addEventListener('click', openCart);
    cartClose.addEventListener('click', closeCart);
    cartOverlay.addEventListener('click', closeCart);
    checkoutBtn.addEventListener('click', proceedToCheckout);

    const heroCTA = document.querySelector('.hero-cta');
    if (heroCTA) {
        heroCTA.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('collections').scrollIntoView({ 
                behavior: 'smooth' 
            });
        });
    }

    document.addEventListener('keydown', handleKeyboardShortcuts);

    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', toggleMobileMenu);
    }
}

function setupHeaderScroll() {
    let lastScrollY = window.scrollY;
    
    window.addEventListener('scroll', () => {
        const currentScrollY = window.scrollY;
        
        if (currentScrollY > 50) {
            header.classList.add('scrolled');
        } else {
            header.classList.remove('scrolled');
        }
        
        lastScrollY = currentScrollY;
    }, { passive: true });
}

// ===== NOTIFICATIONS =====
function showNotification(message, type = 'success') {
    notificationText.textContent = message;
    notification.classList.add('show');
    
    setTimeout(() => {
        notification.classList.remove('show');
    }, 3000);
}

// ===== UTILITY FUNCTIONS =====
function handleKeyboardShortcuts(e) {
    if (e.key === 'Escape') {
        if (cartSidebar.classList.contains('open')) {
            closeCart();
        }
        if (profileUI && document.getElementById('profileModal')?.classList.contains('show')) {
            profileUI.closeProfileModal();
        }
        if (profileUI && document.getElementById('signupPromptModal')?.classList.contains('show')) {
            profileUI.closeSignupPrompt();
        }
        if (mobileMenuInstance && mobileMenuInstance.getIsOpen()) {
            mobileMenuInstance.close();
        }
        // Add this line:
        if (document.getElementById('productDetailModal')?.classList.contains('show')) {
            closeProductDetail();
        }
    }
}

// ===== MOBILE MENU FUNCTIONALITY =====
class MobileMenu {
    constructor() {
        this.menuButton = document.getElementById('mobileMenuBtn');
        this.menu = document.getElementById('mobileMenu');
        this.overlay = document.getElementById('mobileMenuOverlay');
        this.closeButton = document.getElementById('mobileMenuClose');
        this.menuLinks = document.querySelectorAll('.mobile-menu-nav a');
        this.isOpen = false;
        
        this.init();
    }
    
    init() {
        if (!this.menuButton || !this.menu || !this.overlay) {
            console.warn('Mobile menu elements not found');
            return;
        }

        // Event listeners
        this.menuButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
        
        if (this.closeButton) {
            this.closeButton.addEventListener('click', () => this.close());
        }
        
        this.overlay.addEventListener('click', () => this.close());
        
        // Close menu when clicking nav links with filter routing
        this.menuLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                this.handleMobileNavClick(e, link);
            });
        });
        
        // Close menu on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
        
        // Handle window resize - close menu if screen gets larger
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768 && this.isOpen) {
                this.close();
            }
        });
    }
    
    handleMobileNavClick(e, link) {
        const href = link.getAttribute('href');
        
        // Map nav links to filter values (same as desktop)
        const navToFilterMap = {
            '#boys': 'boys',
            '#girls': 'girls',
            '#women': 'women',
            '#collections': 'all'
        };
        
        // Skip home and contact - just close menu
        if (href === '#home' || href === '#contact') {
            setTimeout(() => this.close(), 150);
            return;
        }
        
        // Handle filter routing
        if (navToFilterMap[href]) {
            e.preventDefault();
            
            // Close mobile menu immediately
            this.close();
            
            // Find the collections section
            const collectionsSection = document.querySelector('.collections-section') || 
                                     document.getElementById('collections');
            
            if (collectionsSection) {
                // Scroll to collections section with header offset
                const headerHeight = 100;
                const elementTop = collectionsSection.getBoundingClientRect().top + window.pageYOffset;
                const offsetPosition = elementTop - headerHeight;
                
                window.scrollTo({
                    top: offsetPosition,
                    behavior: 'smooth'
                });
            }
            
            // Activate the correct filter tab after scroll
            setTimeout(() => {
                const targetFilter = navToFilterMap[href];
                const targetTab = document.querySelector(`[data-filter="${targetFilter}"]`);
                
                if (targetTab) {
                    // Simulate clicking the filter tab
                    targetTab.click();
                }
                
                // Log mobile navigation event
                if (firebaseManager) {
                    firebaseManager.logEvent('mobile_nav_filter_used', {
                        filter: targetFilter,
                        navigation_method: 'mobile_menu',
                        timestamp: new Date().toISOString()
                    });
                }
            }, 600); // Wait for scroll animation
        } else {
            // For other links, just close menu after a delay
            setTimeout(() => this.close(), 150);
        }
    }
    
    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }
    
    open() {
        this.isOpen = true;
        this.menu.classList.add('open');
        this.overlay.classList.add('show');
        this.menuButton.classList.add('active');
        document.body.classList.add('mobile-menu-open');
        
        // Focus management for accessibility
        if (this.closeButton) {
            this.closeButton.focus();
        }
        
        // Analytics tracking if available
        if (firebaseManager) {
            firebaseManager.logEvent('mobile_menu_opened', {
                timestamp: new Date().toISOString(),
                screen_width: window.innerWidth
            });
        }
        
        console.log('Mobile menu opened');
    }
    
    close() {
        this.isOpen = false;
        this.menu.classList.remove('open');
        this.overlay.classList.remove('show');
        this.menuButton.classList.remove('active');
        document.body.classList.remove('mobile-menu-open');
        
        // Return focus to menu button for accessibility
        this.menuButton.focus();
        
        console.log('Mobile menu closed');
    }
    
    // Public method to check if menu is open
    getIsOpen() {
        return this.isOpen;
    }
}

// Initialize mobile menu and make it globally available
let mobileMenuInstance = null;

// Update your existing setupEventListeners function
function setupEventListeners() {
    filterTabs.forEach(tab => {
        tab.addEventListener('click', handleFilterChange);
    });

    cartBtn.addEventListener('click', openCart);
    cartClose.addEventListener('click', closeCart);
    cartOverlay.addEventListener('click', closeCart);
    checkoutBtn.addEventListener('click', proceedToCheckout);

    const heroCTA = document.querySelector('.hero-cta');
    if (heroCTA) {
        heroCTA.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('collections').scrollIntoView({ 
                behavior: 'smooth' 
            });
        });
    }

    document.addEventListener('keydown', handleKeyboardShortcuts);

    // Initialize mobile menu instead of the old event listener
    mobileMenuInstance = new MobileMenu();
    
    // Make it globally available
    window.mobileMenuInstance = mobileMenuInstance;
}

// Remove the old toggleMobileMenu function completely and replace with:
function toggleMobileMenu() {
    if (mobileMenuInstance) {
        mobileMenuInstance.toggle();
    }
}

// Update your handleKeyboardShortcuts function to include mobile menu
function handleKeyboardShortcuts(e) {
    if (e.key === 'Escape') {
        if (cartSidebar.classList.contains('open')) {
            closeCart();
        }
        if (profileUI && document.getElementById('profileModal')?.classList.contains('show')) {
            profileUI.closeProfileModal();
        }
        if (profileUI && document.getElementById('signupPromptModal')?.classList.contains('show')) {
            profileUI.closeSignupPrompt();
        }
        // Add mobile menu escape handling
        if (mobileMenuInstance && mobileMenuInstance.getIsOpen()) {
            mobileMenuInstance.close();
        }
    }
}

function scheduleDailyReport() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    
    const msUntilTomorrow = tomorrow.getTime() - now.getTime();
    
    setTimeout(() => {
        if (firebaseManager) {
            firebaseManager.generateDailyReport();
            setInterval(() => {
                firebaseManager.generateDailyReport();
            }, 24 * 60 * 60 * 1000);
        }
    }, msUntilTomorrow);
}

// ===== ANALYTICS HELPER FUNCTIONS =====
async function trackPageView(pageName) {
    if (firebaseManager) {
        await firebaseManager.trackPageView(pageName, {
            timestamp: new Date().toISOString(),
            referrer: document.referrer
        });
    }
}

async function trackUserSession() {
    if (firebaseManager) {
        const sessionData = {
            session_start: new Date().toISOString(),
            user_agent: navigator.userAgent,
            screen_resolution: `${screen.width}x${screen.height}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            language: navigator.language,
            referrer: document.referrer || 'direct'
        };
        
        await firebaseManager.trackCustomerBehavior('session', 'start', sessionData);
    }
}

// ===== PERFORMANCE MONITORING =====
function measurePerformance() {
    if ('performance' in window) {
        window.addEventListener('load', async () => {
            const navigationStart = performance.timeOrigin || performance.timing.navigationStart;
            const loadTime = performance.now();
            
            let finalLoadTime = loadTime;
            if (performance.timing && performance.timing.loadEventEnd && performance.timing.navigationStart) {
                const timingLoadTime = performance.timing.loadEventEnd - performance.timing.navigationStart;
                if (timingLoadTime > 0 && timingLoadTime < 60000) {
                    finalLoadTime = timingLoadTime;
                }
            }
            
            console.log(`Page load time: ${Math.round(finalLoadTime)}ms`);
            
            if (firebaseManager) {
                await firebaseManager.logEvent('performance_metrics', {
                    page_load_time: Math.round(finalLoadTime),
                    user_agent: navigator.userAgent,
                    screen_resolution: `${screen.width}x${screen.height}`,
                    connection_type: navigator.connection?.effectiveType || 'unknown'
                });
            }
        });
    }
}

// ===== ERROR HANDLING =====
window.addEventListener('error', async (e) => {
    console.error('Global error:', e.error);
    
    if (firebaseManager) {
        await firebaseManager.logEvent('javascript_error', {
            message: e.message,
            filename: e.filename,
            line: e.lineno,
            column: e.colno,
            stack: e.error?.stack
        });
    }
});

window.addEventListener('unhandledrejection', async (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    
    if (firebaseManager) {
        await firebaseManager.logEvent('promise_rejection', {
            reason: e.reason,
            stack: e.reason?.stack
        });
    }
});

// ===== INITIALIZE PERFORMANCE MONITORING =====
measurePerformance();

// ===== EXPOSE GLOBAL FUNCTIONS =====
window.addToCart = addToCart;
window.addToWishlist = addToWishlist;
window.removeFromCart = removeFromCart;
window.updateQuantity = updateQuantity;
window.updateCartCount = updateCartCount;
window.updateCartDisplay = updateCartDisplay;

// ===== ADDITIONAL INITIALIZATION =====
setTimeout(async () => {
    if (firebaseManager && firebaseManager.isInitialized) {
        await trackPageView('home');
        await trackUserSession();
    }
}, 2000);

// Navigation to Filter Routing - Direct to filter-tabs section
function setupNavigationRouting() {
    const navLinks = document.querySelectorAll('.nav-menu a');
    
    // Map nav links to filter values
    const navToFilterMap = {
        '#boys': 'boys',
        '#girls': 'girls',
        '#women': 'women',
        '#collections': 'all'
    };
    
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            
            // Skip home and contact
            if (href === '#home' || href === '#contact') return;
            
            // Handle filter routing
            if (navToFilterMap[href]) {
                e.preventDefault();
                
                // Find the collections section to keep it in view
                const collectionsSection = document.querySelector('.collections-section') || 
                                         document.getElementById('collections');
                
                if (collectionsSection) {
                    // Scroll to show the collections section with proper header offset
                    const headerHeight = 100; // Adjust based on your header height
                    const elementTop = collectionsSection.getBoundingClientRect().top + window.pageYOffset;
                    const offsetPosition = elementTop - headerHeight;
                    
                    window.scrollTo({
                        top: offsetPosition,
                        behavior: 'smooth'
                    });
                }
                
                // Activate the correct filter tab after scroll
                setTimeout(() => {
                    const targetFilter = navToFilterMap[href];
                    const targetTab = document.querySelector(`[data-filter="${targetFilter}"]`);
                    
                    if (targetTab) {
                        // Simulate clicking the filter tab - this will trigger your existing handleFilterChange
                        targetTab.click();
                    }
                }, 600); // Wait for scroll animation to complete
            }
        });
    });
}
 // Product Detail Modal Implementation
        

        // Integration functions (to be called from your existing code)
        function showProductDetail(productId) {
            const product = products.find(p => p.id === productId);
            if (!product) {
                console.error('Product not found:', productId);
                return;
            }
            
            currentDetailProduct = product;
            populateProductDetail(product);
            
            const modal = document.getElementById('productDetailModal');
            modal.classList.add('show');
            document.body.style.overflow = 'hidden';
            
            // Track product view
            if (firebaseManager) {
                firebaseManager.trackProductView(productId, {
                    name: product.name,
                    category: product.category,
                    price: product.price,
                    view_source: 'detail_modal'
                });
            }
        }

        function closeProductDetail() {
            const modal = document.getElementById('productDetailModal');
            modal.classList.remove('show');
            document.body.style.overflow = '';
            
            // Reset state
            currentDetailProduct = null;
            selectedSize = '';
            detailQuantity = 1;
            isInWishlist = false;
        }

        function populateProductDetail(product) {
            // Basic product info
            document.getElementById('productBreadcrumb').textContent = getCategoryDisplayName(product.category);
            document.getElementById('productDetailTitle').textContent = product.name;
            document.getElementById('productDetailPrice').textContent = `${product.price.toFixed(2)}`;
            document.getElementById('productDetailImage').src = product.image;
            document.getElementById('productDetailImage').alt = product.name;
            
            // SKU
            const skuElement = document.getElementById('productDetailSku');
            if (product.sku) {
                skuElement.textContent = `SKU: ${product.sku}`;
                skuElement.style.display = 'block';
            } else {
                skuElement.style.display = 'none';
            }
            
            // Description
            document.getElementById('productDetailDescription').textContent = 
                product.description || 'High-quality product crafted with attention to detail and comfort.';
            
            // Stock status
            updateStockBadge(product);
            
            // Size selection (only for clothing)
            const sizeSection = document.getElementById('sizeSection');
            if (product.category !== 'women') {
                sizeSection.style.display = 'block';
                populateSizeSelection();
            } else {
                sizeSection.style.display = 'none';
            }
            
            // Weight info
            const weightRow = document.getElementById('weightRow');
            if (product.weight) {
                document.getElementById('productWeight').textContent = `${product.weight} lbs`;
                weightRow.style.display = 'flex';
            } else {
                weightRow.style.display = 'none';
            }
            
            // Reset quantity
            detailQuantity = 1;
            document.getElementById('quantityDisplay').textContent = '1';
            
            // Check wishlist status
            checkWishlistStatus(product);
            
            // Update cart status
            updateCartStatus(product);
        }

        async function checkWishlistStatus(product) {
    if (!firebaseManager || !firebaseManager.currentProfile) {
        isInWishlist = false;
        updateWishlistButton();
        return;
    }
    
    try {
        const profile = firebaseManager.currentProfile;
        const wishlist = profile.shopping?.wishlist || [];
        isInWishlist = wishlist.some(item => item.product_id === product.id);
        updateWishlistButton();
    } catch (error) {
        console.error('Error checking wishlist status:', error);
        isInWishlist = false;
        updateWishlistButton();
    }
}

function updateWishlistButton() {
    const wishlistBtn = document.getElementById('wishlistBtn');
    const wishlistIcon = document.getElementById('wishlistIcon');
    const wishlistText = document.getElementById('wishlistText');
    
    // Add null checks to prevent errors when modal isn't open
    if (!wishlistBtn || !wishlistIcon || !wishlistText) {
        return;
    }
    
    if (isInWishlist) {
        wishlistBtn.classList.add('saved');
        wishlistIcon.textContent = '♥';
        wishlistText.textContent = 'Saved';
    } else {
        wishlistBtn.classList.remove('saved');
        wishlistIcon.textContent = '♡';
        wishlistText.textContent = 'Save';
    }
}

        function updateStockBadge(product) {
            const badge = document.getElementById('productDetailStockBadge');
            const stockInfo = getStockInfo(product);
            
            badge.textContent = stockInfo.text;
            badge.className = `product-detail-stock-badge stock-${stockInfo.status}`;
        }

        function getStockInfo(product) {
            if (product.preorder && product.stock === 0) {
                return { text: 'Preorder', status: 'preorder' };
            } else if (product.stock === 0) {
                return { text: 'Sold Out', status: 'out-of-stock' };
            } else if (product.stock <= 5) {
                return { text: `Only ${product.stock} left`, status: 'low-stock' };
            } else {
                return { text: 'In Stock', status: 'in-stock' };
            }
        }

        function populateSizeSelection() {
            const sizes = ['XS', 'S', 'M', 'L', 'XL'];
            const container = document.getElementById('sizeSelection');
            container.innerHTML = '';
            
            sizes.forEach(size => {
                const sizeButton = document.createElement('button');
                sizeButton.className = 'size-option';
                sizeButton.textContent = size;
                sizeButton.onclick = () => selectSize(size);
                container.appendChild(sizeButton);
            });
            
            // Select first size by default
            selectedSize = sizes[0];
            container.firstChild.classList.add('selected');
        }

        function selectSize(size) {
            selectedSize = size;
            
            // Update UI
            const sizeButtons = document.querySelectorAll('.size-option');
            sizeButtons.forEach(btn => btn.classList.remove('selected'));
            event.target.classList.add('selected');
        }

        function updateDetailQuantity(change) {
            if (!currentDetailProduct) return;
            
            const newQuantity = Math.max(1, Math.min(currentDetailProduct.stock, detailQuantity + change));
            detailQuantity = newQuantity;
            document.getElementById('quantityDisplay').textContent = newQuantity;
        }

        function updateCartStatus(product) {
    if (!cartManager) return;
    
    try {
        const cartItem = cartManager.getCart().find(item => item.id === product.id);
        const inCartIndicator = document.getElementById('inCartIndicator');
        const addToCartBtn = document.getElementById('addToCartBtn');
        const actionsRow = document.getElementById('actionsRow');
        
        // Add null checks for all DOM elements
        if (!inCartIndicator || !addToCartBtn || !actionsRow) {
            console.warn('Product detail modal elements not found');
            return;
        }
        
        if (cartItem) {
            // Show in cart indicator
            inCartIndicator.style.display = 'flex';
            const inCartText = document.getElementById('inCartText');
            if (inCartText) {
                inCartText.textContent = `${cartItem.quantity} in cart`;
            }
            
            // Update actions row to three-button layout
            actionsRow.className = 'actions-row three-buttons';
            
            // Update primary button to "Update Cart"
            addToCartBtn.textContent = 'Update Cart';
            addToCartBtn.disabled = false;
            
            // Add View Cart button if it doesn't exist
            let viewCartBtn = document.getElementById('viewCartBtn');
            if (!viewCartBtn) {
                viewCartBtn = document.createElement('button');
                viewCartBtn.id = 'viewCartBtn';
                viewCartBtn.className = 'secondary-action-btn';
                viewCartBtn.onclick = () => {
                    if (window.openCart) openCart();
                    closeProductDetail();
                };
                viewCartBtn.textContent = 'View Cart';
                
                // Insert as the second button (between Add to Cart and Wishlist)
                const wishlistBtn = document.getElementById('wishlistBtn');
                if (wishlistBtn) {
                    actionsRow.insertBefore(viewCartBtn, wishlistBtn);
                }
            }
            
        } else {
            // Hide in cart indicator
            inCartIndicator.style.display = 'none';
            
            // Remove View Cart button if it exists
            const viewCartBtn = document.getElementById('viewCartBtn');
            if (viewCartBtn) {
                viewCartBtn.remove();
            }
            
            // Update actions row to two-button layout
            actionsRow.className = 'actions-row two-buttons';
            
            // Update primary button based on stock
            const stockInfo = getStockInfo(product);
            if (stockInfo.status === 'out-of-stock' && !product.preorder) {
                addToCartBtn.textContent = 'Out of Stock';
                addToCartBtn.disabled = true;
            } else if (product.preorder) {
                addToCartBtn.textContent = 'Preorder Now';
                addToCartBtn.disabled = false;
            } else {
                addToCartBtn.textContent = 'Add to Cart';
                addToCartBtn.disabled = false;
            }
        }
    } catch (error) {
        console.error('Error in updateCartStatus:', error);
    }
}

        async function addToCartFromDetail() {
            if (!currentDetailProduct || !cartManager) return;
            
            const stockInfo = getStockInfo(currentDetailProduct);
            if (stockInfo.status === 'out-of-stock' && !currentDetailProduct.preorder) return;
            
            try {
                const btn = document.getElementById('addToCartBtn');
                const originalText = btn.textContent;
                btn.textContent = 'Adding...';
                btn.disabled = true;
                
                // Add to cart with selected options
                const success = await cartManager.addToCart(currentDetailProduct.id, detailQuantity);
                
                if (success) {
                    // Update inventory if not preorder
                    if (!currentDetailProduct.preorder && inventoryManager) {
                        await inventoryManager.updateStock(currentDetailProduct.id, detailQuantity);
                        currentDetailProduct.stock -= detailQuantity;
                        updateStockBadge(currentDetailProduct);
                    }
                    
                    // Track event
                    if (firebaseManager) {
                        await firebaseManager.logEvent('item_added_to_cart_detail', {
                            product: {
                                id: currentDetailProduct.id,
                                name: currentDetailProduct.name,
                                price: currentDetailProduct.price,
                                category: currentDetailProduct.category
                            },
                            quantity: detailQuantity,
                            selected_size: selectedSize,
                            cart_total_items: cartManager.getCartCount(),
                            cart_total_value: cartManager.getCartTotal()
                        });
                    }
                    
                    // Update UI
                    if (window.updateCartCount) updateCartCount();
                    if (window.updateCartDisplay) updateCartDisplay();
                    updateCartStatus(currentDetailProduct);
                    
                    // Show success feedback
                    btn.style.background = '#10b981';
                    btn.textContent = 'Added!';
                    
                    if (window.showNotification) {
                        showNotification(`${currentDetailProduct.name} added to cart`);
                    }
                    
                    // Reset button after delay
                    setTimeout(() => {
                        btn.style.background = '';
                        updateCartStatus(currentDetailProduct);
                    }, 1500);
                    
                } else {
                    throw new Error('Failed to add to cart');
                }
                
            } catch (error) {
                console.error('Failed to add to cart from detail:', error);
                if (window.showNotification) {
                    showNotification('Failed to add item to cart', 'error');
                }
                
                const btn = document.getElementById('addToCartBtn');
                btn.textContent = 'Add to Cart';
                btn.disabled = false;
            }
        }

        async function toggleWishlistFromDetail() {
            if (!currentDetailProduct || !firebaseManager) return;
            
            try {
                const btn = document.getElementById('wishlistBtn');
                const originalBg = btn.style.background;
                
                if (isInWishlist) {
                    // Remove from wishlist
                    await firebaseManager.removeFromWishlist(currentDetailProduct.id);
                    isInWishlist = false;
                    
                    if (window.showNotification) {
                        showNotification(`${currentDetailProduct.name} removed from wishlist`);
                    }
                    
                    // Visual feedback for removal
                    btn.style.background = '#6b7280';
                    setTimeout(() => {
                        btn.style.background = originalBg;
                        updateWishlistButton();
                    }, 1000);
                    
                } else {
                    // Add to wishlist
                    await firebaseManager.addToWishlist(currentDetailProduct.id, {
                        name: currentDetailProduct.name,
                        price: currentDetailProduct.price,
                        category: currentDetailProduct.category,
                        image: currentDetailProduct.image,
                        selected_size: selectedSize
                    });
                    isInWishlist = true;
                    
                    if (window.showNotification) {
                        showNotification(`${currentDetailProduct.name} added to wishlist`);
                    }
                    
                    // Visual feedback for addition
                    btn.style.background = '#ef4444';
                    setTimeout(() => {
                        btn.style.background = originalBg;
                        updateWishlistButton();
                    }, 1000);
                }
                
            } catch (error) {
                console.error('Failed to toggle wishlist:', error);
                if (window.showNotification) {
                    showNotification('Failed to update wishlist', 'error');
                }
            }
        }

        // Close modal when clicking outside
        document.getElementById('productDetailModal').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                closeProductDetail();
            }
        });

        // Close modal with escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('productDetailModal').classList.contains('show')) {
                closeProductDetail();
            }
        });

        // Make functions globally available
        window.showProductDetail = showProductDetail;
        window.closeProductDetail = closeProductDetail;

// Add this line to your initializeApp() function after setupEventListeners():
// setupNavigationRouting();