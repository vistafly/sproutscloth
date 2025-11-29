class FirebaseManager {
    constructor() {
        this.app = null;
        this.db = null;
        this.auth = null;
        this.analytics = null;
        this.isInitialized = false;
        this.profileManager = null;
        this.currentProfile = null;
        
        // Collections
        this.collections = {
            profiles: 'user_profiles',
            products: 'products',
            orders: 'orders',
            analytics: 'analytics',
            dailyAnalytics: 'daily_analytics',
            inventory: 'inventory_alerts',
            reports: 'daily_reports'
        };
    }

    async initialize() {
        try {
            console.log('Initializing Firebase...');
            
            // Initialize Firebase
            this.app = firebase.initializeApp(FIREBASE_CONFIG);
            this.db = firebase.firestore();
            this.auth = firebase.auth();
            
            // Only initialize Analytics in production
            try {
                if (firebase.analytics && !window.location.hostname.includes('localhost')) {
                    this.analytics = firebase.analytics();
                }
            } catch (analyticsError) {
                console.warn('Analytics not available:', analyticsError.message);
            }
            
            // Initialize Profile Manager
            this.profileManager = new FirebaseProfileManager(this.db, this.auth);
            
            // Set up auth state listener
            this.setupAuthStateListener();
            
            console.log('Firebase core initialized, waiting for auth state...');
            
            // CRITICAL FIX: Wait for initial auth state to be determined
            await this.waitForInitialAuthState();
            
            console.log('Auth state determined, initializing profile...');
            
            // Initialize user profile and wait for it to complete
            this.currentProfile = await this.profileManager.initializeProfile();
            
            if (!this.currentProfile) {
                throw new Error('Profile initialization failed - no profile returned');
            }
            
            console.log('Profile initialized successfully:', this.currentProfile.type, this.currentProfile.id);
            
            // Setup analytics console
            this.setupAnalyticsConsole();
            
            this.isInitialized = true;
            console.log('Firebase Manager fully initialized');
            
            return this;
        } catch (error) {
            console.error('Firebase initialization failed:', error);
            this.isInitialized = false;
            
            // Fallback to offline profile manager
            try {
                console.log('Falling back to offline profile manager...');
                this.profileManager = new OfflineProfileManager();
                this.currentProfile = await this.profileManager.initializeProfile();
                console.log('Offline profile manager initialized');
            } catch (offlineError) {
                console.error('Offline profile manager also failed:', offlineError);
            }
            
            throw error;
        }
    }

    // NEW METHOD: Wait for initial auth state to be determined
    waitForInitialAuthState() {
        return new Promise((resolve) => {
            // Set a timeout to avoid waiting forever
            const timeout = setTimeout(() => {
                console.warn('Auth state determination timed out, proceeding as anonymous');
                unsubscribe();
                resolve(null);
            }, 5000);

            const unsubscribe = this.auth.onAuthStateChanged((user) => {
                clearTimeout(timeout);
                console.log('Initial auth state determined:', user ? `logged in as ${user.email}` : 'anonymous user');
                unsubscribe(); // Only listen for the first auth state change
                resolve(user);
            });
        });
    }

    setupAuthStateListener() {
        this.auth.onAuthStateChanged(async (user) => {
            console.log('Auth state changed:', user ? 'User logged in' : 'User logged out');
            
            if (this.profileManager) {
                try {
                    await this.profileManager.handleAuthChange(user);
                    this.currentProfile = await this.profileManager.getCurrentProfile();
                    
                    // Update UI after auth change
                    if (window.profileUI && window.profileUI.loadProfile) {
                        await window.profileUI.loadProfile();
                    }
                    
                    // Sync cart after auth change
                    if (window.cartManager && window.cartManager.syncWithProfile) {
                        await window.cartManager.syncWithProfile();
                        if (window.updateCartCount) window.updateCartCount();
                        if (window.updateCartDisplay) window.updateCartDisplay();
                    }
                    
                    console.log('Auth state change handling completed');
                } catch (error) {
                    console.error('Error handling auth state change:', error);
                }
            }
        });
    }

    async initializeUserProfile() {
        try {
            console.log('Initializing user profile...');
            
            if (!this.profileManager) {
                throw new Error('Profile manager not available');
            }
            
            const profile = await this.profileManager.initializeProfile();
            
            if (!profile) {
                throw new Error('Profile manager returned null profile');
            }
            
            this.currentProfile = profile;
            console.log('User profile initialized successfully:', profile.type, profile.id);
            
            return profile;
        } catch (error) {
            console.error('Failed to initialize user profile:', error);
            throw error;
        }
    }

    // ===== AUTHENTICATION METHODS =====
    
    async signUpUser(email, password, additionalInfo = {}) {
        if (!this.auth) throw new Error('Authentication not available');
        
        try {
            // If user is currently a guest, use the conversion method
            if (this.currentProfile?.type === 'guest' && this.profileManager.convertGuestToRegistered) {
                const userInfo = {
                    email,
                    ...additionalInfo
                };
                
                const updatedProfile = await this.profileManager.convertGuestToRegistered(userInfo, password);
                this.currentProfile = updatedProfile;
                
                await this.logEvent('guest_converted_to_registered', {
                    uid: this.auth.currentUser?.uid,
                    email: email,
                    converted_from_guest: true,
                    cart_items: updatedProfile.shopping?.cart?.items?.length || 0
                });
                
                return this.auth.currentUser;
            } else {
                // Standard signup for new users
                const userCredential = await this.auth.createUserWithEmailAndPassword(email, password);
                const user = userCredential.user;
                
                // Update profile with user info
                await this.updateProfile({
                    personal_info: {
                        email: user.email,
                        ...additionalInfo
                    }
                });
                
                await this.logEvent('user_signed_up', {
                    uid: user.uid,
                    email: user.email,
                    converted_from_guest: false
                });
                
                return user;
            }
        } catch (error) {
            console.error('Sign up failed:', error);
            throw error;
        }
    }

    async signInUser(email, password) {
        if (!this.auth) throw new Error('Authentication not available');
        
        try {
            const userCredential = await this.auth.signInWithEmailAndPassword(email, password);
            const user = userCredential.user;
            
            await this.logEvent('user_signed_in', {
                uid: user.uid,
                email: user.email
            });
            
            return user;
        } catch (error) {
            console.error('Sign in failed:', error);
            throw error;
        }
    }

    async signOutUser() {
        if (!this.auth) return;
        
        try {
            await this.auth.signOut();
            
            await this.logEvent('user_signed_out', {
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            console.error('Sign out failed:', error);
            throw error;
        }
    }

    // ===== PROFILE MANAGEMENT METHODS =====
    
    async getCurrentProfile() {
        return this.profileManager ? await this.profileManager.getCurrentProfile() : null;
    }

    async updateProfile(updates) {
        if (!this.profileManager) return null;
        
        const updatedProfile = await this.profileManager.updateProfile(updates);
        this.currentProfile = updatedProfile;
        return updatedProfile;
    }

    async trackAction(action, data = {}) {
        if (this.profileManager) {
            await this.profileManager.trackAction(action, data);
        }
    }

    async trackPageView(pageName, data = {}) {
        if (this.profileManager) {
            await this.profileManager.trackPageView(pageName, data);
        }
    }

    async trackProductView(productId, productData = {}) {
        if (this.profileManager) {
            await this.profileManager.trackProductView(productId, productData);
        }
    }

    // ===== CART MANAGEMENT =====
    
    async addToCart(productId, quantity = 1) {
        if (this.profileManager) {
            await this.profileManager.addToCart(productId, quantity);
        }
    }

    async removeFromCart(productId) {
        if (this.profileManager) {
            await this.profileManager.removeFromCart(productId);
        }
    }

    async updateCartQuantity(productId, quantity) {
        if (this.profileManager) {
            await this.profileManager.updateCartQuantity(productId, quantity);
        }
    }

    async clearCart() {
        if (this.profileManager) {
            await this.profileManager.clearCart();
        }
    }

    // ===== WISHLIST MANAGEMENT =====
    
    async addToWishlist(productId, productData = {}) {
        if (this.profileManager) {
            await this.profileManager.addToWishlist(productId, productData);
        }
    }

    async removeFromWishlist(productId) {
        if (this.profileManager) {
            await this.profileManager.removeFromWishlist(productId);
        }
    }

    // ===== PRODUCT MANAGEMENT =====
    
    async getProducts() {
        if (!this.db) {
            console.warn('Database not available, using fallback products');
            return this.getFallbackProducts();
        }
        
        try {
            const snapshot = await this.db.collection(this.collections.products)
                .orderBy('created_at', 'desc')
                .get();
            const products = [];
            
            snapshot.forEach(doc => {
                const data = doc.data();
                products.push({
                    id: doc.id,
                    name: data.name || 'Untitled Product',
                    category: data.category || 'uncategorized',
                    price: typeof data.price === 'number' ? data.price : 0,
                    stock: typeof data.stock === 'number' && !isNaN(data.stock) ? data.stock : 0,
                    image: data.image || 'https://via.placeholder.com/600x800?text=No+Image',
                    description: data.description || 'No description available',
                    sku: data.sku || `SKU-${doc.id}`,
                    weight: data.weight || 0.5,
                    dimensions: data.dimensions || 'Standard fit',
                    created_at: data.created_at,
                    updated_at: data.updated_at
                });
            });
            
            console.log(`Loaded ${products.length} products from Firebase`);
            return products;
        } catch (error) {
            console.error('Failed to load products from Firebase:', error);
            return this.getFallbackProducts();
        }
    }

    getFallbackProducts() {
        return [
            {
                id: 'fallback-1',
                name: 'Sample Product',
                category: 'boys',
                price: 29.99,
                stock: 5,
                image: 'https://via.placeholder.com/600x800?text=Sample+Product',
                description: 'Sample product for testing',
                sku: 'SAMPLE-001',
                weight: 0.5,
                dimensions: 'Standard fit'
            }
        ];
    }

    async updateProductStock(productId, newStock, reason = 'update') {
        if (!this.db) return;
        
        try {
            const productRef = this.db.collection(this.collections.products).doc(productId.toString());
            
            await productRef.update({
                stock: newStock,
                updated_at: new Date().toISOString(),
                update_reason: reason
            });
            
            await this.logInventoryChange(productId, newStock, reason);
            console.log(`Product stock updated: ${productId} -> ${newStock}`);
            
        } catch (error) {
            console.error('Failed to update product stock:', error);
            throw error;
        }
    }

    async logInventoryChange(productId, newStock, reason) {
        if (!this.db) return;
        
        try {
            // Get current products to find product name
            const products = await this.getProducts();
            const product = products.find(p => p.id === productId);
            
            await this.db.collection(this.collections.inventory).add({
                product_id: productId,
                product_name: product?.name || 'Unknown',
                new_stock: newStock,
                reason,
                timestamp: new Date().toISOString(),
                profile_id: this.currentProfile?.id
            });
        } catch (error) {
            console.error('Failed to log inventory change:', error);
        }
    }

    // ===== ORDER MANAGEMENT =====
    
    async logOrder(orderData) {
        if (!this.db) return;
        
        try {
            const enrichedOrderData = {
                ...orderData,
                profile_id: this.currentProfile?.id,
                profile_type: this.currentProfile?.type,
                timestamp: new Date().toISOString(),
                status: 'pending',
                source: 'website'
            };
            
            const orderRef = await this.db.collection(this.collections.orders).add(enrichedOrderData);
            
            // Add to profile purchase history
            if (this.profileManager && this.profileManager.addPurchase) {
                await this.profileManager.addPurchase({
                    order_id: orderRef.id,
                    ...enrichedOrderData
                });
            }
            
            console.log('Order logged successfully:', orderRef.id);
            return orderRef.id;
        } catch (error) {
            console.error('Failed to log order:', error);
            throw error;
        }
    }

    // ===== IMPROVED ANALYTICS & EVENTS =====
    
    async logEvent(eventName, eventData = {}) {
        // Analytics disabled - stub method
        return Promise.resolve();
    }

    // Generate unique event ID
    generateEventId() {
        return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Update profile with lightweight analytics summary
    async updateProfileAnalyticsSummary(eventName, eventData) {
        if (!this.currentProfile || !this.db) return;
        
        try {
            const profileRef = this.db.collection(this.collections.profiles).doc(this.currentProfile.id);
            
            // Use Firebase increment operations for counters
            const updateData = {
                'analytics.last_activity': new Date().toISOString(),
                'analytics.total_events': firebase.firestore.FieldValue.increment(1),
                [`analytics.event_counts.${eventName}`]: firebase.firestore.FieldValue.increment(1),
                'updated_at': new Date().toISOString()
            };
            
            // Add specific event data to summary
            if (eventName === 'item_added_to_cart') {
                updateData['analytics.cart_additions'] = firebase.firestore.FieldValue.increment(1);
            } else if (eventName === 'page_view') {
                updateData['analytics.page_views'] = firebase.firestore.FieldValue.increment(1);
            }
            
            await profileRef.update(updateData);
            
        } catch (error) {
            console.warn('Failed to update profile analytics summary:', error);
        }
    }

    // Update daily analytics aggregations
    async updateDailyAnalytics(eventName, eventData, timestamp) {
        if (!this.db) return;
        
        try {
            const dateKey = timestamp.split('T')[0]; // YYYY-MM-DD
            const dailyRef = this.db.collection(this.collections.dailyAnalytics).doc(dateKey);
            
            const updateData = {
                date: dateKey,
                total_events: firebase.firestore.FieldValue.increment(1),
                [`event_counts.${eventName}`]: firebase.firestore.FieldValue.increment(1),
                unique_users: firebase.firestore.FieldValue.arrayUnion(this.currentProfile?.id || 'anonymous'),
                last_updated: new Date().toISOString()
            };
            
            await dailyRef.set(updateData, { merge: true });
            
        } catch (error) {
            console.warn('Failed to update daily analytics:', error);
        }
    }

    // ===== ANALYTICS QUERY METHODS =====
    
    // Get user events (readable, paginated)
    async getUserEvents(userId, options = {}) {
        if (!this.db) return [];
        
        const {
            limit = 50,
            startAfter = null,
            eventType = null,
            startDate = null,
            endDate = null
        } = options;
        
        try {
            let query = this.db
                .collection(this.collections.profiles)
                .doc(userId)
                .collection('events')
                .orderBy('timestamp', 'desc')
                .limit(limit);
            
            if (startAfter) {
                query = query.startAfter(startAfter);
            }
            
            if (eventType) {
                query = query.where('event_name', '==', eventType);
            }
            
            if (startDate) {
                query = query.where('timestamp', '>=', startDate);
            }
            
            if (endDate) {
                query = query.where('timestamp', '<=', endDate);
            }
            
            const snapshot = await query.get();
            const events = [];
            
            snapshot.forEach(doc => {
                events.push(doc.data());
            });
            
            return events;
            
        } catch (error) {
            console.error('Failed to get user events:', error);
            return [];
        }
    }

    // Get daily analytics summary
    async getDailyAnalytics(startDate, endDate) {
        if (!this.db) return [];
        
        try {
            const snapshot = await this.db
                .collection(this.collections.dailyAnalytics)
                .where('date', '>=', startDate)
                .where('date', '<=', endDate)
                .orderBy('date', 'desc')
                .get();
            
            const dailyData = [];
            snapshot.forEach(doc => {
                dailyData.push(doc.data());
            });
            
            return dailyData;
            
        } catch (error) {
            console.error('Failed to get daily analytics:', error);
            return [];
        }
    }

    // Get events by type across all users
    async getEventsByType(eventType, options = {}) {
        if (!this.db) return [];
        
        const {
            limit = 100,
            startDate = null,
            endDate = null
        } = options;
        
        try {
            let query = this.db
                .collection(this.collections.analytics)
                .where('event_name', '==', eventType)
                .orderBy('timestamp', 'desc')
                .limit(limit);
            
            if (startDate) {
                query = query.where('timestamp', '>=', startDate);
            }
            
            if (endDate) {
                query = query.where('timestamp', '<=', endDate);
            }
            
            const snapshot = await query.get();
            const events = [];
            
            snapshot.forEach(doc => {
                events.push(doc.data());
            });
            
            return events;
            
        } catch (error) {
            console.error('Failed to get events by type:', error);
            return [];
        }
    }

    // Get user analytics dashboard data
    async getUserAnalyticsDashboard(userId) {
        if (!this.db) return null;
        
        try {
            // Get user profile with analytics summary
            const profileDoc = await this.db.collection(this.collections.profiles).doc(userId).get();
            
            if (!profileDoc.exists) {
                return null;
            }
            
            const profileData = profileDoc.data();
            const analytics = profileData.analytics || {};
            
            // Get recent events
            const recentEvents = await this.getUserEvents(userId, { limit: 10 });
            
            return {
                user_id: userId,
                summary: {
                    total_events: analytics.total_events || 0,
                    page_views: analytics.page_views || 0,
                    cart_additions: analytics.cart_additions || 0,
                    last_activity: analytics.last_activity,
                    event_counts: analytics.event_counts || {}
                },
                recent_events: recentEvents,
                profile_type: profileData.type,
                member_since: profileData.created_at
            };
            
        } catch (error) {
            console.error('Failed to get user analytics dashboard:', error);
            return null;
        }
    }

    // ===== ANALYTICS REPORTING =====
    
    async generateAnalyticsReport(startDate, endDate) {
        if (!this.db) return null;
        
        try {
            // Get daily analytics
            const dailyData = await this.getDailyAnalytics(startDate, endDate);
            
            // Calculate totals
            const totals = dailyData.reduce((acc, day) => {
                acc.total_events += day.total_events || 0;
                // Fixed: Use Set to count unique users properly
                if (day.unique_users && Array.isArray(day.unique_users)) {
                    day.unique_users.forEach(userId => acc.unique_users_set.add(userId));
                }
                
                // Merge event counts
                Object.entries(day.event_counts || {}).forEach(([event, count]) => {
                    acc.event_counts[event] = (acc.event_counts[event] || 0) + count;
                });
                
                return acc;
            }, {
                total_events: 0,
                unique_users_set: new Set(),
                event_counts: {}
            });
            
            // Convert Set to count
            totals.unique_users = totals.unique_users_set.size;
            delete totals.unique_users_set;
            
            // Get top events
            const topEvents = Object.entries(totals.event_counts)
                .sort(([,a], [,b]) => b - a)
                .slice(0, 10)
                .map(([name, count]) => ({ event_name: name, count }));
            
            return {
                period: { start_date: startDate, end_date: endDate },
                totals,
                top_events: topEvents,
                daily_breakdown: dailyData,
                generated_at: new Date().toISOString()
            };
            
        } catch (error) {
            console.error('Failed to generate analytics report:', error);
            return null;
        }
    }

    // ===== SIMPLE ANALYTICS DASHBOARD METHODS =====

    // Get current user's readable activity summary
    async getMyActivity() {
        if (!this.currentProfile?.id) {
            console.log('No current user profile');
            return null;
        }
        
        const dashboard = await this.getUserAnalyticsDashboard(this.currentProfile.id);
        
        if (!dashboard) {
            console.log('No dashboard data available');
            return null;
        }
        
        console.log('=== MY ACTIVITY SUMMARY ===');
        console.log(`Profile Type: ${dashboard.profile_type}`);
        console.log(`Member Since: ${new Date(dashboard.member_since).toLocaleDateString()}`);
        console.log(`Total Events: ${dashboard.summary.total_events}`);
        console.log(`Page Views: ${dashboard.summary.page_views}`);
        console.log(`Cart Additions: ${dashboard.summary.cart_additions}`);
        console.log(`Last Activity: ${new Date(dashboard.summary.last_activity).toLocaleString()}`);
        
        console.log('\n=== EVENT BREAKDOWN ===');
        Object.entries(dashboard.summary.event_counts).forEach(([event, count]) => {
            console.log(`${event}: ${count}`);
        });
        
        console.log('\n=== RECENT EVENTS ===');
        dashboard.recent_events.slice(0, 5).forEach((event, index) => {
            console.log(`${index + 1}. ${event.event_name} - ${new Date(event.timestamp).toLocaleString()}`);
        });
        
        return dashboard;
    }

    // Get today's website activity
    async getTodaysActivity() {
        const today = new Date().toISOString().split('T')[0];
        const dailyData = await this.getDailyAnalytics(today, today);
        
        if (dailyData.length === 0) {
            console.log('No activity recorded for today');
            return null;
        }
        
        const todayData = dailyData[0];
        
        console.log('=== TODAY\'S WEBSITE ACTIVITY ===');
        console.log(`Date: ${todayData.date}`);
        console.log(`Total Events: ${todayData.total_events}`);
        console.log(`Unique Users: ${todayData.unique_users ? todayData.unique_users.length : 0}`);
        
        console.log('\n=== TODAY\'S EVENT BREAKDOWN ===');
        Object.entries(todayData.event_counts || {}).forEach(([event, count]) => {
            console.log(`${event}: ${count}`);
        });
        
        return todayData;
    }

    // Get this week's summary
    async getWeeklySummary() {
        const today = new Date();
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        
        const startDate = weekAgo.toISOString().split('T')[0];
        const endDate = today.toISOString().split('T')[0];
        
        const report = await this.generateAnalyticsReport(startDate, endDate);
        
        if (!report) {
            console.log('No weekly data available');
            return null;
        }
        
        console.log('=== WEEKLY SUMMARY ===');
        console.log(`Period: ${startDate} to ${endDate}`);
        console.log(`Total Events: ${report.totals.total_events}`);
        console.log(`Unique Users: ${report.totals.unique_users}`);
        
        console.log('\n=== TOP EVENTS THIS WEEK ===');
        report.top_events.slice(0, 5).forEach((event, index) => {
            console.log(`${index + 1}. ${event.event_name}: ${event.count}`);
        });
        
        console.log('\n=== DAILY BREAKDOWN ===');
        report.daily_breakdown.forEach(day => {
            console.log(`${day.date}: ${day.total_events} events, ${day.unique_users ? day.unique_users.length : 0} users`);
        });
        
        return report;
    }

    // Get specific event history
    async getEventHistory(eventType, limit = 20) {
        const events = await this.getEventsByType(eventType, { limit });
        
        console.log(`=== ${eventType.toUpperCase()} HISTORY ===`);
        console.log(`Found ${events.length} events`);
        
        events.forEach((event, index) => {
            const time = new Date(event.timestamp).toLocaleString();
            const user = event.profile_type === 'guest' ? 'Guest' : 'Registered User';
            console.log(`${index + 1}. ${time} - ${user} (${event.profile_id})`);
            
            // Show specific data for different event types
            if (eventType === 'item_added_to_cart' && event.event_data.product) {
                console.log(`   Product: ${event.event_data.product.name} - $${event.event_data.product.price}`);
            }
        });
        
        return events;
    }

    // Search events by user email or name
    async searchUserEvents(searchTerm) {
        if (!this.db) return [];
        
        try {
            // First find users matching the search term
            const usersSnapshot = await this.db.collection(this.collections.profiles)
                .where('personal_info.email', '>=', searchTerm)
                .where('personal_info.email', '<=', searchTerm + '\uf8ff')
                .get();
            
            const results = [];
            
            for (const userDoc of usersSnapshot.docs) {
                const userData = userDoc.data();
                const userId = userDoc.id;
                
                // Get recent events for this user
                const userEvents = await this.getUserEvents(userId, { limit: 10 });
                
                results.push({
                    user: {
                        id: userId,
                        email: userData.personal_info?.email,
                        name: userData.personal_info?.name,
                        type: userData.type
                    },
                    events: userEvents
                });
            }
            
            console.log(`=== USER SEARCH RESULTS FOR "${searchTerm}" ===`);
            results.forEach((result, index) => {
                console.log(`${index + 1}. ${result.user.name || 'No name'} (${result.user.email})`);
                console.log(`   User Type: ${result.user.type}`);
                console.log(`   Recent Events: ${result.events.length}`);
                
                result.events.slice(0, 3).forEach(event => {
                    console.log(`   - ${event.event_name} (${new Date(event.timestamp).toLocaleString()})`);
                });
                console.log('');
            });
            
            return results;
            
        } catch (error) {
            console.error('Failed to search user events:', error);
            return [];
        }
    }

    // Quick analytics console commands
    setupAnalyticsConsole() {
        // Add these to the global window object for easy console access
        window.analytics = {
            // My activity
            my: () => this.getMyActivity(),
            
            // Today's activity  
            today: () => this.getTodaysActivity(),
            
            // This week's summary
            week: () => this.getWeeklySummary(),
            
            // Event histories
            signups: () => this.getEventHistory('guest_converted_to_registered', 10),
            carts: () => this.getEventHistory('item_added_to_cart', 20),
            pageViews: () => this.getEventHistory('page_view', 15),
            logins: () => this.getEventHistory('user_signed_in', 10),
            
            // Search users
            search: (term) => this.searchUserEvents(term),
            
            // Custom event history
            events: (eventType, limit = 20) => this.getEventHistory(eventType, limit),
            
            // Custom date range
            range: (startDate, endDate) => this.generateAnalyticsReport(startDate, endDate),
            
            // Help
            help: () => {
                console.log('=== ANALYTICS CONSOLE COMMANDS ===');
                console.log('analytics.my() - My activity summary');
                console.log('analytics.today() - Today\'s website activity');
                console.log('analytics.week() - This week\'s summary');
                console.log('analytics.signups() - Recent user signups');
                console.log('analytics.carts() - Recent cart additions');
                console.log('analytics.pageViews() - Recent page views');
                console.log('analytics.logins() - Recent logins');
                console.log('analytics.search("email") - Search user by email');
                console.log('analytics.events("event_name", 20) - Get event history');
                console.log('analytics.range("2025-01-01", "2025-01-07") - Custom date range');
                console.log('analytics.help() - Show this help');
            }
        };
        
        console.log('Analytics console ready! Type analytics.help() for commands');
    }

    // ===== UTILITY METHODS =====
    
    // Clean up old events (run periodically to manage storage)
    async cleanupOldEvents(daysToKeep = 90) {
        if (!this.db) return;
        
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
            const cutoffTimestamp = cutoffDate.toISOString();
            
            // Clean up main analytics collection
            const oldEventsSnapshot = await this.db
                .collection(this.collections.analytics)
                .where('timestamp', '<', cutoffTimestamp)
                .limit(500) // Process in batches
                .get();
            
            const batch = this.db.batch();
            oldEventsSnapshot.forEach(doc => {
                batch.delete(doc.ref);
            });
            
            await batch.commit();
            
            console.log(`Cleaned up ${oldEventsSnapshot.size} old events`);
            
        } catch (error) {
            console.error('Failed to cleanup old events:', error);
        }
    }

    // Export user data for GDPR compliance
    async exportUserAnalytics(userId) {
        try {
            const dashboard = await this.getUserAnalyticsDashboard(userId);
            const allEvents = await this.getUserEvents(userId, { limit: 1000 });
            
            return {
                user_id: userId,
                dashboard_summary: dashboard,
                all_events: allEvents,
                export_timestamp: new Date().toISOString()
            };
            
        } catch (error) {
            console.error('Failed to export user analytics:', error);
            return null;
        }
    }

    // ===== CUSTOMER BEHAVIOR TRACKING =====
    
    async trackCustomerBehavior(category, action, data = {}) {
        const behaviorData = {
            category,
            action,
            data,
            timestamp: new Date().toISOString(),
            profile_id: this.currentProfile?.id,
            session_id: this.currentProfile?.session_id
        };
        
        await this.logEvent('customer_behavior', behaviorData);
    }

    // ===== REPORTING =====
    
    async generateDailyReport() {
        if (!this.db) return;
        
        try {
            const today = new Date();
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            
            const startOfDay = new Date(yesterday);
            startOfDay.setHours(0, 0, 0, 0);
            
            const endOfDay = new Date(yesterday);
            endOfDay.setHours(23, 59, 59, 999);
            
            // Get orders from yesterday
            const ordersSnapshot = await this.db.collection(this.collections.orders)
                .where('timestamp', '>=', startOfDay.toISOString())
                .where('timestamp', '<=', endOfDay.toISOString())
                .get();
            
            // Get analytics from yesterday
            const analyticsSnapshot = await this.db.collection(this.collections.analytics)
                .where('timestamp', '>=', startOfDay.toISOString())
                .where('timestamp', '<=', endOfDay.toISOString())
                .get();
            
            // Process data
            const orders = [];
            let totalRevenue = 0;
            
            ordersSnapshot.forEach(doc => {
                const order = doc.data();
                orders.push(order);
                totalRevenue += order.totals?.total || 0;
            });
            
            const events = [];
            const pageViews = new Set();
            const uniqueProfiles = new Set();
            
            analyticsSnapshot.forEach(doc => {
                const event = doc.data();
                events.push(event);
                
                if (event.event_name === 'page_view') {
                    pageViews.add(event.page_url);
                }
                
                if (event.profile_id) {
                    uniqueProfiles.add(event.profile_id);
                }
            });
            
            // Generate report
            const report = {
                date: yesterday.toISOString().split('T')[0],
                generated_at: new Date().toISOString(),
                orders: {
                    count: orders.length,
                    total_revenue: totalRevenue,
                    average_order_value: orders.length > 0 ? totalRevenue / orders.length : 0
                },
                traffic: {
                    unique_visitors: uniqueProfiles.size,
                    page_views: pageViews.size,
                    total_events: events.length
                },
                top_events: this.getTopEvents(events),
                inventory_alerts: await this.getInventoryAlerts(startOfDay, endOfDay)
            };
            
            // Save report
            await this.db.collection(this.collections.reports).add(report);
            
            console.log('Daily report generated:', report);
            return report;
            
        } catch (error) {
            console.error('Failed to generate daily report:', error);
        }
    }

    getTopEvents(events) {
        const eventCounts = {};
        
        events.forEach(event => {
            const eventName = event.event_name;
            eventCounts[eventName] = (eventCounts[eventName] || 0) + 1;
        });
        
        return Object.entries(eventCounts)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 10)
            .map(([name, count]) => ({ name, count }));
    }

    async getInventoryAlerts(startDate, endDate) {
        if (!this.db) return [];
        
        try {
            const alertsSnapshot = await this.db.collection(this.collections.inventory)
                .where('timestamp', '>=', startDate.toISOString())
                .where('timestamp', '<=', endDate.toISOString())
                .get();
            
            const alerts = [];
            alertsSnapshot.forEach(doc => {
                alerts.push(doc.data());
            });
            
            return alerts;
        } catch (error) {
            console.error('Failed to get inventory alerts:', error);
            return [];
        }
    }

    // ===== PROFILE EXPORT (for data portability) =====
    
    async exportProfileData() {
        if (!this.currentProfile) return null;
        
        const exportData = {
            profile: this.currentProfile,
            export_timestamp: new Date().toISOString(),
            export_version: '1.0'
        };
        
        await this.logEvent('profile_data_exported', {
            profile_id: this.currentProfile.id,
            export_size: JSON.stringify(exportData).length
        });
        
        return exportData;
    }

    // ===== PROFILE STATUS CHECKER (for debugging) =====
    
    getProfileStatus() {
        return {
            firebase_initialized: this.isInitialized,
            profile_manager_exists: !!this.profileManager,
            current_profile_exists: !!this.currentProfile,
            current_profile_type: this.currentProfile?.type,
            current_profile_id: this.currentProfile?.id,
            auth_user: this.auth?.currentUser?.email || 'none',
            database_available: !!this.db
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FirebaseManager;
}