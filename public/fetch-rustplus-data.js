/**
 * Rust+ Token Grabber - Reusable Module
 * Provides functions to fetch fresh data and retrieve stored data from the Firefox extension
 */

class RustPlusDataFetcher {
    constructor() {
        this.pollInterval = null;
        this.clearTimestamp = null;
    }

    /**
     * Fetch fresh Rust+ data by clearing old data and opening Steam login
     * @returns {Promise<Object>} Promise that resolves with fresh data
     */
    async fetchFreshData() {
        return new Promise((resolve, reject) => {
            // Clear any existing data first
            document.getElementById('dataDisplay')?.classList.remove('show');
            
            // Clear old data from extension storage
            this.clearData().then(() => {
                // Set timestamp for when we cleared the data
                this.clearTimestamp = new Date().getTime();
                
                // Open Rust+ login page in popup window
                const returnUrl = encodeURIComponent(window.location.href);
                const rustUrl = `https://companion-rust.facepunch.com/login?returnUrl=${returnUrl}`;
                const popup = window.open(rustUrl, 'rustLogin', 'width=800,height=600,scrollbars=yes,resizable=yes');

                // Start polling for new data
                this.startPolling(resolve, reject);
            });
        });
    }

    /**
     * Get previously stored Rust+ data from extension
     * @returns {Promise<Object|null>} Promise that resolves with stored data or null
     */
    async getStoredData() {
        return new Promise((resolve) => {
            // Try to use postMessage to communicate with the extension
            const message = { type: 'GET_RUST_DATA' };
            
            // Send message to extension via postMessage
            window.postMessage(message, '*');
            
            // Listen for response
            const handleMessage = (event) => {
                if (event.data && event.data.type === 'RUST_DATA_RESPONSE') {
                    window.removeEventListener('message', handleMessage);
                    // Return the data directly (no wrapper)
                    resolve(event.data.data);
                }
            };
            
            window.addEventListener('message', handleMessage);
            
            // Timeout after 5 seconds
            setTimeout(() => {
                window.removeEventListener('message', handleMessage);
                resolve(null);
            }, 5000);
        });
    }

    /**
     * Start polling for new data after Steam login
     * @param {Function} resolve - Promise resolve function
     * @param {Function} reject - Promise reject function
     */
    startPolling(resolve, reject) {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
        
        let pollCount = 0;
        const maxPolls = 150; // 5 minutes max (2 seconds * 150)
        
        this.pollInterval = setInterval(async () => {
            pollCount++;
            
            try {
                const data = await this.getStoredData();
                if (data && data.SteamId) {
                    // Check if this data is newer than when we cleared the cache
                    const dataTimestamp = new Date(data.createdAt).getTime();
                    if (this.clearTimestamp && dataTimestamp > this.clearTimestamp) {
                        this.stopPolling();
                        // Return the data directly
                        resolve(data);
                    }
                } else if (pollCount >= maxPolls) {
                    this.stopPolling();
                    reject(new Error('Timeout waiting for data'));
                }
            } catch (error) {
                if (pollCount >= maxPolls) {
                    this.stopPolling();
                    reject(new Error('Error fetching data from extension'));
                }
            }
        }, 2000); // Poll every 2 seconds
    }

    /**
     * Stop the polling interval
     */
    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    /**
     * Clear stored data from extension
     * @returns {Promise<boolean>} Promise that resolves with success status
     */
    async clearData() {
        return new Promise((resolve) => {
            try {
                // Send message to extension via postMessage
                const message = { type: 'CLEAR_RUST_DATA' };
                window.postMessage(message, '*');
                
                // Listen for response
                const handleMessage = (event) => {
                    if (event.data && event.data.type === 'RUST_DATA_RESPONSE') {
                        if (event.data.data && event.data.data.success) {
                            document.getElementById('dataDisplay')?.classList.remove('show');
                            window.removeEventListener('message', handleMessage);
                            resolve(true);
                        }
                    }
                };
                
                window.addEventListener('message', handleMessage);
                
                // Timeout after 5 seconds
                setTimeout(() => {
                    window.removeEventListener('message', handleMessage);
                    document.getElementById('dataDisplay')?.classList.remove('show');
                    resolve(true);
                }, 5000);
            } catch (error) {
                resolve(false);
            }
        });
    }
}

// Create a singleton instance
const rustPlusFetcher = new RustPlusDataFetcher();

// Export the main functions
export async function fetchRustPlusData() {
    return await rustPlusFetcher.fetchFreshData();
}

export async function getStoredRustPlusData() {
    return await rustPlusFetcher.getStoredData();
}

// Also export the class for advanced usage
export { RustPlusDataFetcher };