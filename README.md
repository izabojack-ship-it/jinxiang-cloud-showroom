# 金享車業雲端展間

15 站 360° 虛擬實境環景導覽（依工廠動線）。

## 公開網址

主網址：https://izabojack-ship-it.github.io/jinxiang-cloud-showroom/

若主網址無法開啟（部分網路環境會擋 github.io），可改用備用網址：

- https://cdn.jsdelivr.net/gh/izabojack-ship-it/jinxiang-cloud-showroom@main/index.html
- https://rawcdn.githack.com/izabojack-ship-it/jinxiang-cloud-showroom/main/index.html

## 導覽順序

1. 工廠大門  
2. 一樓品保實驗室 → 模治具室  
3. 雷射/貼標生產線  
4. 一樓走道空間 → 一樓生產線-前 → 一樓生產線-中 → 一樓生產線-後  
5. CNC加工區  
6. 噴砂區  
7. 倉庫區  
8. 二樓門口 → 二樓走廊 → 二樓設計課 → 二樓業務部  

## 上線內容

公開倉庫僅包含瀏覽器用檔案：

- `index.html`、`css/`、`js/`
- `media/panoramas/`、`media/thumbs/`、`media/stations.json`

原始拍攝與拼接腳本不會上傳。

## 本機預覽

```powershell
cd "D:\金享車業雲端展間"
python -m http.server 7979
```

開啟 http://localhost:7979

### 虛擬導覽員（試作：一樓品保實驗室）

- 展間：http://localhost:7979/index.html?scene=station-1f-qa-lab  
- 文案／點位編輯：http://localhost:7979/editor.html  
- 定位模式：http://localhost:7979/index.html?scene=station-1f-qa-lab&place=1  

建議流程：在編輯頁改文案 → 對機台按「定位此點」→ 在環景點正確位置（座標即時寫回本機）→ 確認後下載覆蓋 `media/stations.json`。語音使用瀏覽器 Web Speech（建議 Chrome）；尚未部署上線。
