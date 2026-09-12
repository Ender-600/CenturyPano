"""Process-local priority for paid stages, in addition to the durable file lock.

Foreground work may overtake queued predictions. A stage already holding the
slot is never interrupted; its provider may have already accepted payment.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from contextlib import asynccontextmanager
import weakref


_LOOPS = weakref.WeakKeyDictionary()


class PaidQueue:
    def __init__(self):
        self.condition = asyncio.Condition()
        self.waiting = []
        self.active = False
        self.sequence = 0
        self.foreground_images = Counter()
        self.promotions = {}

    def promote(self, owner, image_key):
        if owner not in self.promotions:
            self.promotions[owner] = image_key
            self.foreground_images[image_key] += 1

    def release(self, owner):
        image_key = self.promotions.pop(owner, None)
        if image_key is not None:
            self.foreground_images[image_key] -= 1
            if not self.foreground_images[image_key]:
                del self.foreground_images[image_key]

    @asynccontextmanager
    async def slot(self, priority, check):
        self.sequence += 1
        ticket = (self.sequence, priority)
        self.waiting.append(ticket)
        acquired = False
        try:
            async with self.condition:
                while True:
                    check()
                    first = min(self.waiting, key=lambda item: (item[1](), item[0]))
                    if not self.active and first is ticket:
                        self.waiting.remove(ticket)
                        self.active = acquired = True
                        break
                    # Also recheck deadlines, cancellation and promotions when
                    # another process owns the persisted provider lock.
                    try:
                        await asyncio.wait_for(self.condition.wait(), .1)
                    except TimeoutError:
                        pass
            yield
        finally:
            async with self.condition:
                if ticket in self.waiting:
                    self.waiting.remove(ticket)
                if acquired:
                    self.active = False
                self.condition.notify_all()


def paid_queue(root):
    queues = _LOOPS.setdefault(asyncio.get_running_loop(), {})
    return queues.setdefault(str(root), PaidQueue())
