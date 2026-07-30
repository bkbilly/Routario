"""
Geocoding Service
Reverse geocoding with Redis caching
"""
import asyncio
from typing import Optional, Tuple
import logging
import hashlib

from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut, GeocoderServiceError
import redis.asyncio as redis

logger = logging.getLogger(__name__)


class GeocodingService:
    """
    Async reverse geocoding service with caching
    """
    
    def __init__(self, redis_url: str = "redis://localhost:6379", cache_ttl: int = 86400):
        self.redis_url = redis_url
        self.cache_ttl = cache_ttl  # 24 hours default
        self.redis_client: Optional[redis.Redis] = None
        self._last_request_time: float = 0.0
        self._rate_lock = asyncio.Lock()
        
        # Initialize geocoder (blocking, will run in executor)
        self.geocoder = Nominatim(user_agent="Routario-Platform/1.0 (https://github.com/bkbilly/Routario)")
    
    async def connect(self):
        """Connect to Redis (optional - degrades gracefully if unavailable)"""
        try:
            self.redis_client = await redis.from_url(self.redis_url, decode_responses=True)
            logger.info("Geocoding service connected to Redis")
        except Exception as exc:
            logger.warning("Geocoding: Redis unavailable, running without cache: %s", exc)
            self.redis_client = None
    
    async def close(self):
        """Close connections"""
        if self.redis_client:
            try:
                await self.redis_client.close()
            except Exception:
                pass
            self.redis_client = None
    
    def _get_cache_key(self, latitude: float, longitude: float) -> str:
        """Generate cache key for coordinates"""
        # Round to ~100m precision (5 decimal places)
        lat_rounded = round(latitude, 5)
        lon_rounded = round(longitude, 5)
        
        return f"geocode:{lat_rounded}:{lon_rounded}"
    
    async def _get_from_cache(self, latitude: float, longitude: float) -> Optional[str]:
        """Get address from cache"""
        if not self.redis_client:
            return None
        
        cache_key = self._get_cache_key(latitude, longitude)
        
        try:
            address = await self.redis_client.get(cache_key)
            if address:
                logger.debug(f"Cache hit for ({latitude}, {longitude})")
            return address
        except Exception as e:
            logger.error(f"Redis get error: {e}")
            return None
    
    async def _set_cache(self, latitude: float, longitude: float, address: str):
        """Store address in cache"""
        if not self.redis_client:
            return
        
        cache_key = self._get_cache_key(latitude, longitude)
        
        try:
            await self.redis_client.setex(cache_key, self.cache_ttl, address)
            logger.debug(f"Cached address for ({latitude}, {longitude})")
        except Exception as e:
            logger.error(f"Redis set error: {e}")
    
    async def reverse_geocode(
        self,
        latitude: float,
        longitude: float,
        timeout: int = 5
    ) -> Optional[str]:
        """
        Reverse geocode coordinates to address
        """
        if latitude is None or longitude is None or (latitude == 0.0 and longitude == 0.0):
            return None

        # Check cache first
        cached_address = await self._get_from_cache(latitude, longitude)
        
        if cached_address:
            return cached_address
        
        # Enforce rate limit (1 request per second for Nominatim TOS compliance)
        async with self._rate_lock:
            import time
            now = time.time()
            elapsed = now - self._last_request_time
            if elapsed < 1.0:
                await asyncio.sleep(1.0 - elapsed)
            self._last_request_time = time.time()

            # Perform geocoding in executor (blocking)
            try:
                loop = asyncio.get_event_loop()
                
                location = await loop.run_in_executor(
                    None,
                    self._reverse_geocode_sync,
                    latitude,
                    longitude,
                    timeout
                )
                
                if location and location.address:
                    address = location.address
                    
                    # Cache result
                    await self._set_cache(latitude, longitude, address)
                    
                    logger.info(f"Geocoded ({latitude}, {longitude}) -> {address}")
                    return address
                
                return None
            
            except (GeocoderTimedOut, GeocoderServiceError) as e:
                logger.warning(f"Geocoding error: {e}")
                return None
            except Exception as e:
                logger.error(f"Unexpected geocoding error: {e}", exc_info=True)
                return None
    
    def _reverse_geocode_sync(self, latitude: float, longitude: float, timeout: int):
        """Synchronous geocoding call"""
        return self.geocoder.reverse(
            f"{latitude}, {longitude}",
            timeout=timeout,
            language="en"
        )
    
    async def batch_reverse_geocode(
        self,
        coordinates: list[Tuple[float, float]]
    ) -> dict[Tuple[float, float], Optional[str]]:
        """
        Batch reverse geocode multiple coordinates
        
        Args:
            coordinates: List of (latitude, longitude) tuples
        
        Returns:
            Dict mapping coordinates to addresses
        """
        results = {}
        
        # Use semaphore to limit concurrent requests
        semaphore = asyncio.Semaphore(5)
        
        async def geocode_with_semaphore(lat, lon):
            async with semaphore:
                address = await self.reverse_geocode(lat, lon)
                return (lat, lon), address
        
        # Create tasks
        tasks = [
            geocode_with_semaphore(lat, lon)
            for lat, lon in coordinates
        ]
        
        # Execute in parallel
        completed = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Collect results
        for result in completed:
            if isinstance(result, tuple):
                coords, address = result
                results[coords] = address
        
        return results


# ==================== Global Geocoding Service ====================

geocoding_service: Optional[GeocodingService] = None


async def init_geocoding_service(redis_url: str = "redis://localhost:6379") -> GeocodingService:
    """Initialize global geocoding service"""
    global geocoding_service
    geocoding_service = GeocodingService(redis_url)
    await geocoding_service.connect()
    return geocoding_service


def get_geocoding_service() -> GeocodingService:
    """Get global geocoding service instance"""
    if geocoding_service is None:
        raise RuntimeError("Geocoding service not initialized")
    return geocoding_service
