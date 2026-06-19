import { Client } from "baltica";

// Cấu hình tài khoản và máy chủ kết nối
const BOT_CONFIG = {
  address: "donutsmp.net",
  port: 19132,
  online: true,
  username: "BotDuyLengds",
};

// Danh sách vật phẩm rác cần lọc bỏ khỏi túi đồ
const TRASH_ITEM_KEYWORDS = ["cobblestone", "dirt", "gravel", "rotten_flesh", "poisonous_potato"];

/**
 * Giao diện quản lý trạng thái nội bộ của Bot
 */
interface BotRuntimeState {
  position: { x: number; y: number; z: number };
  runtimeEntityId: bigint;
  currentTick: bigint;
  isSpawned: boolean;
  tickLoopInterval: Timer | null;
  fallbackTimeout: Timer | null;
}

/**
 * Khởi chạy tiến trình Bot độc lập và thiết lập hệ thống tự chữa lành
 */
async function initializeBotAgent(): Promise<void> {
  console.log("=========================================");
  console.log("🚀 [SYSTEM] Khởi tạo tiến trình RakNet Client...");

  const client = new Client(BOT_CONFIG);

  const state: BotRuntimeState = {
    position: { x: 0, y: 0, z: 0 },
    runtimeEntityId: 1n,
    currentTick: 0n,
    isSpawned: false,
    tickLoopInterval: null,
    fallbackTimeout: null,
  };

  // ========================================================
  // BỘ XỬ LÝ GÓI TIN (PACKET ENGINE) TRÁNH ANTICHEAT
  // ========================================================
  client.on("packet", (packet: any) => {
    // Trích xuất định danh gói tin bằng cả ID số và Tên lớp để tăng độ chính xác
    const packetId = packet.id ?? packet.pid ?? packet.constructor?.id;
    const packetName = packet.constructor?.name || packet.name || "";

    // 1. Phản hồi gói tin giữ mạng (NetworkStackLatency - ID: 115)
    if (packetId === 115 || packetName.includes("NetworkStackLatency")) {
      try {
        const timestamp = packet.timestamp ?? packet.data?.timestamp ?? 0n;
        client.send("NetworkStackLatency", {
          timestamp: BigInt(timestamp.toString()),
          needResponse: false,
          needsResponse: false // Đệm kép thuộc tính để tránh lệch phiên bản core
        });
      } catch (error) {}
    }

    // 2. Đồng bộ trạng thái khi vào thế giới (StartGame - ID: 11)
    if (packetId === 11 || packetName.includes("StartGame")) {
      try {
        const payload = packet.data ?? packet;
        state.runtimeEntityId = BigInt(payload.runtimeEntityId ?? 1);
        
        if (payload.playerPosition) {
          state.position = payload.playerPosition;
        }
        
        if (!state.isSpawned) {
          state.isSpawned = true;
          console.log(`🎉 [SYSTEM] Kích hoạt Bot thành công với Entity ID: ${state.runtimeEntityId}`);
        }
      } catch (error) {}
    }

    // 3. Cập nhật vị trí thời gian thực (MovePlayer - ID: 19)
    if (packetId === 19 || packetName.includes("MovePlayer")) {
      try {
        const payload = packet.data ?? packet;
        const entityId = payload.runtimeEntityId ?? 0;
        
        if (BigInt(entityId) === state.runtimeEntityId || state.position.x === 0) {
          state.position = payload.position ?? state.position;
          if (payload.tick) {
            state.currentTick = BigInt(payload.tick.toString());
          }
        }
      } catch (error) {}
    }

    // 4. Quản lý kho đồ và lọc rác tự động (InventoryContent - ID: 52)
    if (packetId === 52 || packetName.includes("InventoryContent")) {
      try {
        const payload = packet.data ?? packet;
        const itemSlots = payload.slots || payload.input || [];
        
        itemSlots.forEach((item: any, index: number) => {
          if (item && (item.networkName || item.name)) {
            const nameString = item.networkName || item.name;
            const targetTrash = TRASH_ITEM_KEYWORDS.some(keyword => nameString.includes(keyword));
            
            if (targetTrash) {
              console.log(`[CLEANER] Phát hiện vật phẩm rác: ${nameString} tại ô [${index}]. Đang dọn dẹp...`);
              client.send("InventoryTransaction", {
                transactionType: "normal",
                actions: [
                  {
                    sourceType: "container",
                    containerId: 0,
                    slot: index,
                    oldItem: item,
                    newItem: { networkId: 0 }
                  }
                ]
              });
            }
          }
        });
      } catch (error) {}
    }
  });

  // ========================================================
  // QUẢN LÝ KẾT NỐI VÀ CƠ CHẾ RECONNECT AN TOÀN
  // ========================================================
  client.on("disconnect", async (reason) => {
    console.log(`❌ [DISCONNECT] Chuỗi kết nối bị ngắt. Lý do: ${reason}`);
    state.isSpawned = false;
    
    // Thu hồi tài nguyên chạy ngầm để tránh rò rỉ bộ nhớ
    if (state.tickLoopInterval) clearInterval(state.tickLoopInterval);
    if (state.fallbackTimeout) clearTimeout(state.fallbackTimeout);
    
    console.log("⏳ [RECONNECT] Sẽ tái khởi động luồng RakNet mới sau 3 giây...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    initializeBotAgent(); 
  });

  // Kích hoạt kết nối tầng mạng
  try {
    await client.connect();
    console.log("✅ [CONNECT] Cổng UDP RakNet đã thông suốt!");

    // CƠ CHẾ KIỂM SOÁT TREO LUỒNG: Ép buộc chạy nếu StartGame không phản hồi sau 5 giây
    state.fallbackTimeout = setTimeout(() => {
      if (!state.isSpawned) {
        state.isSpawned = true;
        console.log("⚠️ [WARNING] Không nhận được StartGame, kích hoạt cơ chế ép buộc đồng bộ.");
      }
    }, 5000);

    // Vòng lặp gửi dữ liệu đồng bộ nhịp tim (50ms = 1 Tick)
    state.tickLoopInterval = setInterval(() => {
      if (!client || !state.isSpawned) return;
      
      state.currentTick++;

      // Duy trì gói tin di chuyển và tương tác mạng
      try {
        client.send("PlayerAuthInput", {
          position: state.position,
          pitch: 0,
          yaw: 0,
          headYaw: 0,
          inputData: { _value: 0n },
          inputMode: "mouse",
          playMode: "normal",
          tick: state.currentTick,
          delta: { x: 0, y: 0, z: 0 },
          itemInteractionData: null
        });
      } catch (error) {}

      // Tự động tương tác chuột phải định kỳ (Mỗi 1 giây / 20 Ticks)
      if (state.currentTick % 20n === 0n) {
        try {
          client.send("PlayerAction", {
            runtimeEntityId: state.runtimeEntityId,
            action: "use_item",
            position: { 
              x: Math.floor(state.position.x), 
              y: Math.floor(state.position.y) - 1, 
              z: Math.floor(state.position.z) 
            },
            resultPosition: { x: 0, y: 0, z: 0 },
            face: 0
          });
          console.log(`-> [ACTION] Gửi lệnh sử dụng vật phẩm tại Server Tick: ${state.currentTick}`);
        } catch (error) {}
      }
    }, 50);

  } catch (err: any) {
    console.log("❌ [ERROR] Lỗi kết nối ban đầu, tiến hành thử lại sau 5 giây...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    initializeBotAgent();
  }
}

// Thực thi hệ thống
initializeBotAgent();
