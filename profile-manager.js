// ===== PROFILE MANAGER CLASSES =====

// Base Profile Manager Interface
class BaseProfileManager {
    constructor() {
        this.currentProfile = null;
    }

    async initializeProfile() {
        throw new Error('initializeProfile must be implemented by subclass');
    }

    async getCurrentProfile() {
        return this.currentProfile;
    }

    async updateProfile(updates) {
        throw new Error('updateProfile must be implemented by subclass');
    }

    async trackAction(action, data) {
        throw new Error('trackAction must be implemented by subclass');
    }

    generateProfileId() {
        return 'profile_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    generateSessionId() {
        let sessionId = sessionStorage.getItem('session_id');
        if (!sessionId) {
            sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            sessionStorage.setItem('session_id', sessionId);
        }
        return sessionId;
    }

    createBaseProfile(profileId, profileType = 'guest') {
        return {
            id: profileId,
            type: profileType, // 'guest' or 'registered'
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            session_id: this.generateSessionId(),
            
            // Personal Information
            personal_info: {
                email: null,
                name: null,
                phone: null,
                addresses: []
            },
            
            // Shopping Data
            shopping: {
                cart: {
                    items: [],
                    total: 0,
                    updated_at: null
                },
                wishlist: [],
                purchase_history: [],
                abandoned_carts: []
            },
            
            // Browsing Behavior
            browsing: {
                page_views: [],
                product_views: [],
                categories_visited: [],
                search_queries: [],
                time_spent: 0,
                last_active: new Date().toISOString()
            },
            
            // Analytics Events
            analytics: {
                events: [],
                filters_used: [],
                actions_taken: []
            },
            
            // Preferences and Settings
            preferences: {
                currency: 'USD',
                notifications: true,
                marketing_emails: false,
                size_preferences: {},
                favorite_categories: []
            },
            
            // Metadata
            metadata: {
                user_agent: navigator.userAgent,
                screen_resolution: `${screen.width}x${screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                language: navigator.language,
                referrer: document.referrer || 'direct',
                first_visit: new Date().toISOString(),
                visit_count: 1
            }
        };
    }
}

// Firebase Profile Manager
class FirebaseProfileManager extends BaseProfileManager {
    constructor(db, auth) {
        super();
        this.db = db;
        this.auth = auth;
        this.profilesCollection = 'user_profiles';
        this.batchUpdateScheduled = false;
    }

    async initializeProfile() {
        try {
            const user = this.auth.currentUser;
            
            if (user) {
                this.currentProfile = await this.loadRegisteredProfile(user);
            } else {
                this.currentProfile = await this.loadGuestProfile();
            }
            
            return this.currentProfile;
        } catch (error) {
            console.error('Failed to initialize profile:', error);
            this.currentProfile = this.createFallbackProfile();
            return this.currentProfile;
        }
    }

    async loadRegisteredProfile(user) {
        try {
            const profileDoc = await this.db.collection(this.profilesCollection).doc(user.uid).get();
            
            if (profileDoc.exists) {
                const profile = profileDoc.data();
                
                // Merge any guest session data if exists
                await this.mergeGuestData(profile);
                
                // Update last active
                await this.updateLastActive(user.uid);
                
                return profile;
            } else {
                // Create new registered profile
                return await this.createRegisteredProfile(user);
            }
        } catch (error) {
            console.error('Failed to load registered profile:', error);
            throw error;
        }
    }

    async createRegisteredProfile(user) {
        try {
            const profileId = user.uid;
            const profile = this.createBaseProfile(profileId, 'registered');
            
            // Add user-specific info
            profile.personal_info.email = user.email;
            profile.personal_info.name = user.displayName;
            
            // Merge any guest session data
            await this.mergeGuestData(profile);
            
            // Save to Firebase
            await this.db.collection(this.profilesCollection).doc(profileId).set(profile);
            
            console.log('Created new registered profile:', profileId);
            return profile;
        } catch (error) {
            console.error('Failed to create registered profile:', error);
            throw error;
        }
    }

     async loadGuestProfile() {
        try {
            const sessionId = this.generateSessionId();
            const guestProfileKey = `guest_profile_${sessionId}`;
            
            const localProfile = localStorage.getItem(guestProfileKey);
            if (localProfile) {
                const profile = JSON.parse(localProfile);
                
                try {
                    await this.syncGuestProfileToFirebase(profile);
                } catch (error) {
                    console.warn('Failed to sync guest profile to Firebase:', error);
                }
                
                return profile;
            }
            
            const profileId = `guest_${sessionId}`;
            const profile = this.createBaseProfile(profileId, 'guest');
            
            localStorage.setItem(guestProfileKey, JSON.stringify(profile));
            
            try {
                await this.db.collection(this.profilesCollection).doc(profileId).set(profile);
            } catch (error) {
                console.warn('Failed to save guest profile to Firebase:', error);
            }
            
            return profile;
        } catch (error) {
            console.error('Failed to load guest profile:', error);
            return this.createFallbackProfile();
        }
    }

    // NEW METHOD: Convert guest session to registered profile
    async convertGuestToRegistered(userInfo, password) {
        if (!this.currentProfile || this.currentProfile.type !== 'guest') {
            throw new Error('No guest profile to convert');
        }

        try {
            // Create Firebase auth user
            const userCredential = await this.auth.createUserWithEmailAndPassword(userInfo.email, password);
            const user = userCredential.user;

            // Update user display name
            if (userInfo.name) {
                await user.updateProfile({ displayName: userInfo.name });
            }

            // Get current guest profile data
            const guestProfile = { ...this.currentProfile };
            const sessionId = this.generateSessionId();
            const guestProfileKey = `guest_profile_${sessionId}`;

            // Create new registered profile using SAME document ID (overwriting guest)
            const registeredProfile = {
                ...guestProfile, // Keep all existing data
                id: user.uid, // Use Firebase Auth UID as the new profile ID
                type: 'registered',
                updated_at: new Date().toISOString(),
                personal_info: {
                    ...guestProfile.personal_info,
                    email: userInfo.email,
                    name: userInfo.name,
                    phone: userInfo.phone || null
                },
                preferences: {
                    ...guestProfile.preferences,
                    marketing_emails: userInfo.marketing_emails || false
                },
                converted_from_guest: {
                    original_guest_id: guestProfile.id,
                    converted_at: new Date().toISOString(),
                    guest_session_id: sessionId
                }
            };

            // CRITICAL: Delete the old guest document first
            try {
                await this.db.collection(this.profilesCollection).doc(guestProfile.id).delete();
                console.log('Deleted old guest profile:', guestProfile.id);
            } catch (error) {
                console.warn('Failed to delete old guest profile:', error);
            }

            // Save new registered profile with user's UID
            await this.db.collection(this.profilesCollection).doc(user.uid).set(registeredProfile);

            // Clean up local storage
            localStorage.removeItem(guestProfileKey);

            // Update current profile reference
            this.currentProfile = registeredProfile;

            console.log('Successfully converted guest to registered profile:', user.uid);
            
            // Log conversion event
            await this.trackAction('guest_converted_to_registered', {
                original_guest_id: guestProfile.id,
                new_user_id: user.uid,
                cart_items: registeredProfile.shopping.cart.items.length,
                cart_value: registeredProfile.shopping.cart.total
            });

            return registeredProfile;

        } catch (error) {
            console.error('Failed to convert guest to registered:', error);
            throw error;
        }
    }

    async syncGuestProfileToFirebase(profile) {
        if (!this.db) return;
        
        try {
            await this.db.collection(this.profilesCollection).doc(profile.id).set(profile, { merge: true });
        } catch (error) {
            console.warn('Failed to sync guest profile to Firebase:', error);
        }
    }

    async mergeGuestData(registeredProfile) {
        try {
            const sessionId = this.generateSessionId();
            const guestProfileKey = `guest_profile_${sessionId}`;
            const guestData = localStorage.getItem(guestProfileKey);
            
            if (!guestData) return;
            
            const guestProfile = JSON.parse(guestData);
            
            // Merge shopping data
            if (guestProfile.shopping.cart.items.length > 0) {
                registeredProfile.shopping.cart = guestProfile.shopping.cart;
            }
            
            // Merge wishlist
            if (guestProfile.shopping.wishlist.length > 0) {
                registeredProfile.shopping.wishlist = [
                    ...registeredProfile.shopping.wishlist,
                    ...guestProfile.shopping.wishlist.filter(item => 
                        !registeredProfile.shopping.wishlist.find(existing => existing.product_id === item.product_id)
                    )
                ];
            }
            
            // Merge browsing history
            registeredProfile.browsing.page_views = [
                ...registeredProfile.browsing.page_views,
                ...guestProfile.browsing.page_views
            ];
            
            registeredProfile.browsing.product_views = [
                ...registeredProfile.browsing.product_views,
                ...guestProfile.browsing.product_views
            ];
            
            // Merge analytics events
            registeredProfile.analytics.events = [
                ...registeredProfile.analytics.events,
                ...guestProfile.analytics.events
            ];
            
            // Update metadata
            registeredProfile.metadata.visit_count += guestProfile.metadata.visit_count;
            
            // Clean up guest data
            localStorage.removeItem(guestProfileKey);
            
            // Update Firebase
            await this.db.collection(this.profilesCollection).doc(registeredProfile.id).update(registeredProfile);
            
            console.log('Successfully merged guest data into registered profile');
        } catch (error) {
            console.warn('Failed to merge guest data:', error);
        }
    }

    async handleAuthChange(user) {
        if (user && this.currentProfile?.type === 'guest') {
            // User just logged in, merge guest data
            this.currentProfile = await this.loadRegisteredProfile(user);
        } else if (!user && this.currentProfile?.type === 'registered') {
            // User logged out, create new guest profile
            this.currentProfile = await this.loadGuestProfile();
        }
    }

    async updateProfile(updates) {
        if (!this.currentProfile) return null;
        
        try {
            // Update local profile
            Object.assign(this.currentProfile.personal_info, updates.personal_info || {});
            Object.assign(this.currentProfile.preferences, updates.preferences || {});
            this.currentProfile.updated_at = new Date().toISOString();
            
            // Save to Firebase
            if (this.db) {
                await this.db.collection(this.profilesCollection).doc(this.currentProfile.id).update({
                    personal_info: this.currentProfile.personal_info,
                    preferences: this.currentProfile.preferences,
                    updated_at: this.currentProfile.updated_at
                });
            }
            
            // Save locally for guests
            if (this.currentProfile.type === 'guest') {
                const sessionId = this.generateSessionId();
                const guestProfileKey = `guest_profile_${sessionId}`;
                localStorage.setItem(guestProfileKey, JSON.stringify(this.currentProfile));
            }
            
            return this.currentProfile;
        } catch (error) {
            console.error('Failed to update profile:', error);
            throw error;
        }
    }

    async trackAction(action, data = {}) {
        if (!this.currentProfile) return;
        
        try {
            const event = {
                action,
                data,
                timestamp: new Date().toISOString(),
                page_url: window.location.href,
                user_agent: navigator.userAgent
            };
            
            // Add to profile
            this.currentProfile.analytics.events.push(event);
            this.currentProfile.browsing.last_active = new Date().toISOString();
            this.currentProfile.updated_at = new Date().toISOString();
            
            // Keep only last 1000 events
            if (this.currentProfile.analytics.events.length > 1000) {
                this.currentProfile.analytics.events = this.currentProfile.analytics.events.slice(-1000);
            }
            
            // Save to Firebase (batched)
            await this.batchUpdateProfile();
            
        } catch (error) {
            console.error('Failed to track action:', error);
        }
    }

    async trackPageView(pageName, data = {}) {
        if (!this.currentProfile) return;
        
        const pageView = {
            page: pageName,
            data,
            timestamp: new Date().toISOString(),
            url: window.location.href
        };
        
        this.currentProfile.browsing.page_views.push(pageView);
        this.currentProfile.browsing.last_active = new Date().toISOString();
        
        // Keep only last 500 page views
        if (this.currentProfile.browsing.page_views.length > 500) {
            this.currentProfile.browsing.page_views = this.currentProfile.browsing.page_views.slice(-500);
        }
        
        await this.batchUpdateProfile();
    }

    async trackProductView(productId, productData = {}) {
        if (!this.currentProfile) return;
        
        const productView = {
            product_id: productId,
            product_data: productData,
            timestamp: new Date().toISOString()
        };
        
        this.currentProfile.browsing.product_views.push(productView);
        
        // Keep only last 100 product views
        if (this.currentProfile.browsing.product_views.length > 100) {
            this.currentProfile.browsing.product_views = this.currentProfile.browsing.product_views.slice(-100);
        }
        
        await this.batchUpdateProfile();
    }

    async addToCart(productId, quantity = 1) {
        if (!this.currentProfile) return;
        
        const existingItem = this.currentProfile.shopping.cart.items.find(item => item.product_id === productId);
        
        if (existingItem) {
            existingItem.quantity += quantity;
            existingItem.updated_at = new Date().toISOString();
        } else {
            this.currentProfile.shopping.cart.items.push({
                product_id: productId,
                quantity,
                added_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }
        
        await this.updateCartTotal();
        await this.batchUpdateProfile();
    }

    async removeFromCart(productId) {
        if (!this.currentProfile) return;
        
        this.currentProfile.shopping.cart.items = this.currentProfile.shopping.cart.items.filter(
            item => item.product_id !== productId
        );
        
        await this.updateCartTotal();
        await this.batchUpdateProfile();
    }

    async updateCartQuantity(productId, quantity) {
        if (!this.currentProfile) return;
        
        const item = this.currentProfile.shopping.cart.items.find(item => item.product_id === productId);
        if (item) {
            if (quantity <= 0) {
                await this.removeFromCart(productId);
            } else {
                item.quantity = quantity;
                item.updated_at = new Date().toISOString();
                await this.updateCartTotal();
                await this.batchUpdateProfile();
            }
        }
    }

    async clearCart() {
        if (!this.currentProfile) return;
        
        // Save as abandoned cart if it had items
        if (this.currentProfile.shopping.cart.items.length > 0) {
            this.currentProfile.shopping.abandoned_carts.push({
                ...this.currentProfile.shopping.cart,
                abandoned_at: new Date().toISOString()
            });
            
            // Keep only last 10 abandoned carts
            if (this.currentProfile.shopping.abandoned_carts.length > 10) {
                this.currentProfile.shopping.abandoned_carts = this.currentProfile.shopping.abandoned_carts.slice(-10);
            }
        }
        
        this.currentProfile.shopping.cart = {
            items: [],
            total: 0,
            updated_at: new Date().toISOString()
        };
        
        await this.batchUpdateProfile();
    }

    async addToWishlist(productId, productData = {}) {
        if (!this.currentProfile) return;
        
        const existingItem = this.currentProfile.shopping.wishlist.find(item => item.product_id === productId);
        if (!existingItem) {
            this.currentProfile.shopping.wishlist.push({
                product_id: productId,
                product_data: productData,
                added_at: new Date().toISOString()
            });
            
            await this.batchUpdateProfile();
        }
    }

    async removeFromWishlist(productId) {
        if (!this.currentProfile) return;
        
        this.currentProfile.shopping.wishlist = this.currentProfile.shopping.wishlist.filter(
            item => item.product_id !== productId
        );
        
        await this.batchUpdateProfile();
    }

    async addPurchase(orderData) {
        if (!this.currentProfile) return;
        
        const purchase = {
            ...orderData,
            purchased_at: new Date().toISOString()
        };
        
        this.currentProfile.shopping.purchase_history.push(purchase);
        
        // Clear cart after purchase
        await this.clearCart();
        
        await this.batchUpdateProfile();
    }

    async updateCartTotal() {
        if (!this.currentProfile || typeof products === 'undefined') return;
        
        let total = 0;
        this.currentProfile.shopping.cart.items.forEach(item => {
            const product = products.find(p => p.id === item.product_id);
            if (product) {
                total += product.price * item.quantity;
            }
        });
        
        this.currentProfile.shopping.cart.total = total;
        this.currentProfile.shopping.cart.updated_at = new Date().toISOString();
    }

    async updateLastActive(profileId) {
        if (!this.db) return;
        
        try {
            await this.db.collection(this.profilesCollection).doc(profileId).update({
                'browsing.last_active': new Date().toISOString(),
                'metadata.visit_count': firebase.firestore.FieldValue.increment(1)
            });
        } catch (error) {
            console.warn('Failed to update last active:', error);
        }
    }

    // Batched updates to prevent too many Firebase writes
    batchUpdateScheduled = false;
    async batchUpdateProfile() {
        if (this.batchUpdateScheduled) return;
        
        this.batchUpdateScheduled = true;
        
        setTimeout(async () => {
            try {
                if (this.db && this.currentProfile) {
                    await this.db.collection(this.profilesCollection).doc(this.currentProfile.id).set(this.currentProfile, { merge: true });
                }
                
                // Save locally for guests
                if (this.currentProfile?.type === 'guest') {
                    const sessionId = this.generateSessionId();
                    const guestProfileKey = `guest_profile_${sessionId}`;
                    localStorage.setItem(guestProfileKey, JSON.stringify(this.currentProfile));
                }
            } catch (error) {
                console.warn('Failed to batch update profile:', error);
            } finally {
                this.batchUpdateScheduled = false;
            }
        }, 2000); // Batch updates every 2 seconds
    }

    createFallbackProfile() {
        const profileId = `fallback_${Date.now()}`;
        return this.createBaseProfile(profileId, 'guest');
    }
}

// Offline Profile Manager
class OfflineProfileManager extends BaseProfileManager {
    constructor() {
        super();
        this.storageKey = 'offline_profile';
    }

    async initializeProfile() {
        try {
            // Try to load existing profile from localStorage
            const storedProfile = localStorage.getItem(this.storageKey);
            
            if (storedProfile) {
                this.currentProfile = JSON.parse(storedProfile);
                
                // Update visit count and last active
                this.currentProfile.metadata.visit_count += 1;
                this.currentProfile.browsing.last_active = new Date().toISOString();
                this.currentProfile.updated_at = new Date().toISOString();
                
                await this.saveProfile();
            } else {
                // Create new profile
                const profileId = this.generateProfileId();
                this.currentProfile = this.createBaseProfile(profileId, 'guest');
                await this.saveProfile();
            }
            
            return this.currentProfile;
        } catch (error) {
            console.error('Failed to initialize offline profile:', error);
            const profileId = this.generateProfileId();
            this.currentProfile = this.createBaseProfile(profileId, 'guest');
            return this.currentProfile;
        }
    }

    async updateProfile(updates) {
        if (!this.currentProfile) return null;
        
        Object.assign(this.currentProfile.personal_info, updates.personal_info || {});
        Object.assign(this.currentProfile.preferences, updates.preferences || {});
        this.currentProfile.updated_at = new Date().toISOString();
        
        await this.saveProfile();
        return this.currentProfile;
    }

    async trackAction(action, data = {}) {
        if (!this.currentProfile) return;
        
        const event = {
            action,
            data,
            timestamp: new Date().toISOString(),
            page_url: window.location.href,
            user_agent: navigator.userAgent
        };
        
        this.currentProfile.analytics.events.push(event);
        this.currentProfile.browsing.last_active = new Date().toISOString();
        this.currentProfile.updated_at = new Date().toISOString();
        
        // Keep only last 1000 events
        if (this.currentProfile.analytics.events.length > 1000) {
            this.currentProfile.analytics.events = this.currentProfile.analytics.events.slice(-1000);
        }
        
        await this.saveProfile();
    }

    async trackPageView(pageName, data = {}) {
        if (!this.currentProfile) return;
        
        const pageView = {
            page: pageName,
            data,
            timestamp: new Date().toISOString(),
            url: window.location.href
        };
        
        this.currentProfile.browsing.page_views.push(pageView);
        this.currentProfile.browsing.last_active = new Date().toISOString();
        
        if (this.currentProfile.browsing.page_views.length > 500) {
            this.currentProfile.browsing.page_views = this.currentProfile.browsing.page_views.slice(-500);
        }
        
        await this.saveProfile();
    }

    async trackProductView(productId, productData = {}) {
        if (!this.currentProfile) return;
        
        const productView = {
            product_id: productId,
            product_data: productData,
            timestamp: new Date().toISOString()
        };
        
        this.currentProfile.browsing.product_views.push(productView);
        
        if (this.currentProfile.browsing.product_views.length > 100) {
            this.currentProfile.browsing.product_views = this.currentProfile.browsing.product_views.slice(-100);
        }
        
        await this.saveProfile();
    }

    async addToCart(productId, quantity = 1) {
        if (!this.currentProfile) return;
        
        const existingItem = this.currentProfile.shopping.cart.items.find(item => item.product_id === productId);
        
        if (existingItem) {
            existingItem.quantity += quantity;
            existingItem.updated_at = new Date().toISOString();
        } else {
            this.currentProfile.shopping.cart.items.push({
                product_id: productId,
                quantity,
                added_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }
        
        await this.updateCartTotal();
        await this.saveProfile();
    }

    async removeFromCart(productId) {
        if (!this.currentProfile) return;
        
        this.currentProfile.shopping.cart.items = this.currentProfile.shopping.cart.items.filter(
            item => item.product_id !== productId
        );
        
        await this.updateCartTotal();
        await this.saveProfile();
    }

    async updateCartQuantity(productId, quantity) {
        if (!this.currentProfile) return;
        
        const item = this.currentProfile.shopping.cart.items.find(item => item.product_id === productId);
        if (item) {
            if (quantity <= 0) {
                await this.removeFromCart(productId);
            } else {
                item.quantity = quantity;
                item.updated_at = new Date().toISOString();
                await this.updateCartTotal();
                await this.saveProfile();
            }
        }
    }

    async clearCart() {
        if (!this.currentProfile) return;
        
        if (this.currentProfile.shopping.cart.items.length > 0) {
            this.currentProfile.shopping.abandoned_carts.push({
                ...this.currentProfile.shopping.cart,
                abandoned_at: new Date().toISOString()
            });
            
            if (this.currentProfile.shopping.abandoned_carts.length > 10) {
                this.currentProfile.shopping.abandoned_carts = this.currentProfile.shopping.abandoned_carts.slice(-10);
            }
        }
        
        this.currentProfile.shopping.cart = {
            items: [],
            total: 0,
            updated_at: new Date().toISOString()
        };
        
        await this.saveProfile();
    }

    async addToWishlist(productId, productData = {}) {
        if (!this.currentProfile) return;
        
        const existingItem = this.currentProfile.shopping.wishlist.find(item => item.product_id === productId);
        if (!existingItem) {
            this.currentProfile.shopping.wishlist.push({
                product_id: productId,
                product_data: productData,
                added_at: new Date().toISOString()
            });
            
            await this.saveProfile();
        }
    }

    async removeFromWishlist(productId) {
        if (!this.currentProfile) return;
        
        this.currentProfile.shopping.wishlist = this.currentProfile.shopping.wishlist.filter(
            item => item.product_id !== productId
        );
        
        await this.saveProfile();
    }

    async addPurchase(orderData) {
        if (!this.currentProfile) return;
        
        const purchase = {
            ...orderData,
            purchased_at: new Date().toISOString()
        };
        
        this.currentProfile.shopping.purchase_history.push(purchase);
        await this.clearCart();
        await this.saveProfile();
    }

    async updateCartTotal() {
        if (!this.currentProfile || typeof products === 'undefined') return;
        
        let total = 0;
        this.currentProfile.shopping.cart.items.forEach(item => {
            const product = products.find(p => p.id === item.product_id);
            if (product) {
                total += product.price * item.quantity;
            }
        });
        
        this.currentProfile.shopping.cart.total = total;
        this.currentProfile.shopping.cart.updated_at = new Date().toISOString();
    }

    async saveProfile() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.currentProfile));
        } catch (error) {
            console.error('Failed to save profile to localStorage:', error);
        }
    }

    async handleAuthChange(user) {
        // In offline mode, we can't handle auth changes
        console.log('Auth change detected in offline mode - profile will remain local');
    }
}

// Export classes
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FirebaseProfileManager, OfflineProfileManager };
}