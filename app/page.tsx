"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type VideoItem = {
  id: number;
  video_url: string;
  created_at: string;
  uploader_token: string | null;
  like_count: number | null;
  comment_count: number | null;
};

type CommentItem = {
  id: number;
  video_id: number;
  content: string;
  created_at: string;
};

export default function Home() {
  const snapContainerRef = useRef<HTMLDivElement>(null);
  const snapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [recording, setRecording] = useState(false);
  const [videoURL, setVideoURL] = useState("");
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [userToken, setUserToken] = useState("");

  const [commentOpen, setCommentOpen] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [commentText, setCommentText] = useState("");
  const [sendingComment, setSendingComment] = useState(false);

  useEffect(() => {
    const token =
      localStorage.getItem("uploader_token") || crypto.randomUUID();

    localStorage.setItem("uploader_token", token);
    setUserToken(token);

    fetchVideos();
    initSnapCamera();

    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function initSnapCamera() {
    try {
      if (typeof window === "undefined") return;

      const apiToken = process.env.NEXT_PUBLIC_SNAP_API_TOKEN;
      const lensId = process.env.NEXT_PUBLIC_SNAP_LENS_ID;
      const lensGroupId = process.env.NEXT_PUBLIC_SNAP_LENS_GROUP_ID;

      if (!apiToken || !lensId || !lensGroupId) {
        setCameraError(
          `API TOKEN: ${apiToken ? "✅ OK" : "❌ MISSING"}

LENS ID: ${lensId ? "✅ OK" : "❌ MISSING"}

GROUP ID: ${lensGroupId ? "✅ OK" : "❌ MISSING"}`
        );
        return;
      }

      if (!snapContainerRef.current) return;

      const cameraKitModule = await import("@snap/camera-kit");

      const {
        bootstrapCameraKit,
        createMediaStreamSource,
        Transform2D,
      } = cameraKitModule;

      const cameraKit = await bootstrapCameraKit({
        apiToken,
      });

      const session = await cameraKit.createSession();

      snapContainerRef.current.innerHTML = "";
      snapContainerRef.current.appendChild(session.output.live);

      snapCanvasRef.current = session.output.live as HTMLCanvasElement;

      session.output.live.className =
        "w-full h-full object-contain rounded-[28px] bg-black";

      const stream = await navigator.mediaDevices.getUserMedia({
  video: {
    facingMode: "user",
    width: { ideal: 1280 },
    height: { ideal: 720 },
    aspectRatio: { ideal: 16 / 9 },
  },
  audio: true,
});

      cameraStreamRef.current = stream;

      const source = createMediaStreamSource(stream, {
        transform: Transform2D.MirrorX,
        cameraType: "user",
      });

      await session.setSource(source);

      const lens = await cameraKit.lensRepository.loadLens(
        lensId,
        lensGroupId
      );

      await session.applyLens(lens);


await session.play();

      setCameraReady(true);
      setCameraError("");
    } catch (error: any) {
      console.error("SNAP ERROR:", error);

      setCameraError(
        error?.message || JSON.stringify(error) || "Snap Lens 載入失敗"
      );
    }
  }

  async function fetchVideos() {
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    setVideos(data || []);
  }

  async function fetchComments(videoId: number) {
    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("video_id", videoId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      return;
    }

    setComments(data || []);
  }

  function openComments(item: VideoItem) {
    setSelectedVideo(item);
    setCommentOpen(true);
    setCommentText("");
    fetchComments(item.id);
  }

  function closeComments() {
    setCommentOpen(false);
    setSelectedVideo(null);
    setComments([]);
    setCommentText("");
  }

  function startRecording() {
    const snapCanvas = snapCanvasRef.current;
    const cameraStream = cameraStreamRef.current;

    if (!snapCanvas || !cameraStream) {
      alert("Lens 尚未載入完成");
      return;
    }

    chunks.current = [];

    const outputStream = snapCanvas.captureStream(30);

    cameraStream.getAudioTracks().forEach((track) => {
      outputStream.addTrack(track);
    });

    const recorder = new MediaRecorder(outputStream, {
      mimeType: "video/webm",
    });

    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);

      setVideoBlob(blob);
      setVideoURL(url);
    };

    recorder.start();
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  async function uploadVideo() {
    if (!videoBlob) {
      alert("請先錄影");
      return;
    }

    setUploading(true);

    const fileName = `video-${Date.now()}.webm`;

    const { error: uploadError } = await supabase.storage
      .from("susu")
      .upload(fileName, videoBlob, {
        contentType: "video/webm",
      });

    if (uploadError) {
      console.error(uploadError);
      alert("影片上傳失敗");
      setUploading(false);
      return;
    }

    const { data } = supabase.storage.from("susu").getPublicUrl(fileName);

    const { error: insertError } = await supabase.from("videos").insert([
      {
        video_url: data.publicUrl,
        uploader_token: userToken,
        like_count: 0,
        comment_count: 0,
      },
    ]);

    if (insertError) {
      console.error(insertError);
      alert("資料庫寫入失敗");
      setUploading(false);
      return;
    }

    alert("影片上傳成功");

    setUploading(false);
    setVideoURL("");
    setVideoBlob(null);
    fetchVideos();
  }

  async function likeVideo(item: VideoItem) {
    const { data: existingLike } = await supabase
      .from("likes")
      .select("*")
      .eq("video_id", item.id)
      .eq("voter_token", userToken)
      .maybeSingle();

    if (existingLike) {
      alert("你已點讚過");
      return;
    }

    const { error } = await supabase.from("likes").insert([
      {
        video_id: item.id,
        voter_token: userToken,
      },
    ]);

    if (error) {
      console.error(error);
      alert("點讚失敗");
      return;
    }

    await supabase
      .from("videos")
      .update({ like_count: (item.like_count || 0) + 1 })
      .eq("id", item.id);

    fetchVideos();
  }

  async function submitComment() {
    if (!selectedVideo) return;

    const content = commentText.trim();

    if (!content) {
      alert("請輸入留言內容");
      return;
    }

    setSendingComment(true);

    const { error } = await supabase.from("comments").insert([
      {
        video_id: selectedVideo.id,
        content,
      },
    ]);

    if (error) {
      console.error(error);
      alert("留言失敗");
      setSendingComment(false);
      return;
    }

    await supabase
      .from("videos")
      .update({
        comment_count: (selectedVideo.comment_count || 0) + 1,
      })
      .eq("id", selectedVideo.id);

    setCommentText("");
    setSendingComment(false);

    await fetchComments(selectedVideo.id);
    await fetchVideos();

    setSelectedVideo({
      ...selectedVideo,
      comment_count: (selectedVideo.comment_count || 0) + 1,
    });
  }

  async function deleteVideo(item: VideoItem) {
    if (item.uploader_token !== userToken) {
      alert("只有上傳者可以刪除");
      return;
    }

    if (!confirm("確定刪除影片？")) return;

    const fileName = item.video_url.split("/").pop();

    if (fileName) {
      await supabase.storage.from("susu").remove([fileName]);
    }

    const { error } = await supabase
      .from("videos")
      .delete()
      .eq("id", item.id);

    if (error) {
      console.error(error);
      alert("刪除失敗");
      return;
    }

    fetchVideos();
  }

  return (
    <main className="bg-black min-h-screen text-white">
      <section className="min-h-screen flex flex-col items-center justify-center gap-5 px-4 py-8 border-b border-white/10">
        <h1 className="text-3xl font-black tracking-wide text-center">
          AR Lens Video Recorder
        </h1>

        <div className="w-full max-w-[420px] aspect-[3/4] rounded-[28px] border border-white/20 bg-black shadow-2xl overflow-hidden flex items-center justify-center">
          <div
           className="w-full h-full flex items-center justify-center">
  <div
    ref={snapContainerRef}
    className="w-[20%] h-[20%]"
  />
</div>
          /
        </div>

        {!cameraReady && (
          <p className="text-sm text-white/60 text-center max-w-[320px] whitespace-pre-line">
            {cameraError || "Lens 載入中，請稍候..."}
          </p>
        )}

        {cameraReady && !recording ? (
          <button
            onClick={startRecording}
            className="bg-white text-black px-7 py-3 rounded-2xl font-bold text-base"
          >
            開始錄影
          </button>
        ) : cameraReady && recording ? (
          <button
            onClick={stopRecording}
            className="bg-red-500 text-white px-7 py-3 rounded-2xl font-bold text-base"
          >
            停止錄影
          </button>
        ) : null}

        {videoURL && (
          <div className="w-full max-w-[420px] flex flex-col gap-3">
            <video
              src={videoURL}
              controls
              className="w-full rounded-3xl border border-white/20"
            />

            <button
              onClick={uploadVideo}
              disabled={uploading}
              className="bg-green-500 text-white px-6 py-3 rounded-2xl font-bold"
            >
              {uploading ? "上傳中..." : "上傳影片"}
            </button>
          </div>
        )}
      </section>

      <section className="flex flex-col items-center gap-10 px-3 py-8">
        {videos.length === 0 ? (
          <div className="min-h-[50vh] flex items-center justify-center text-white/50 text-lg">
            目前尚無作品
          </div>
        ) : (
          videos.map((item, index) => (
            <article
              key={item.id}
              className="w-full max-w-[430px] flex flex-col gap-3"
            >
              <video
                src={item.video_url}
                controls
                playsInline
                loop
                className="w-full object-contain bg-black rounded-[28px] border border-white/15 shadow-2xl"
              />

              <div className="w-full rounded-[24px] border border-white/25 bg-black/80 backdrop-blur-xl px-3 py-3 shadow-xl">
                <div className="grid grid-cols-4 divide-x divide-white/20 text-center">
                  <button
                    onClick={() => likeVideo(item)}
                    className="flex flex-col items-center justify-center gap-1 px-1"
                  >
                    <span className="text-2xl">👍</span>
                    <span className="text-sm font-bold">點讚</span>
                    <span className="text-xs text-white/60">
                      {item.like_count || 0} 個讚
                    </span>
                  </button>

                  <button
                    onClick={() => openComments(item)}
                    className="flex flex-col items-center justify-center gap-1 px-1"
                  >
                    <span className="text-2xl">💬</span>
                    <span className="text-sm font-bold">留言</span>
                    <span className="text-xs text-white/60">
                      {item.comment_count || 0} 則
                    </span>
                  </button>

                  <div className="flex flex-col items-center justify-center gap-1 px-1">
                    <span className="text-2xl">⭐</span>
                    <span className="text-sm font-bold">作品</span>
                    <span className="text-xs text-violet-300 font-bold">
                      #{videos.length - index}
                    </span>
                  </div>

                  {item.uploader_token === userToken ? (
                    <button
                      onClick={() => deleteVideo(item)}
                      className="flex flex-col items-center justify-center gap-1 px-1 text-red-100"
                    >
                      <span className="text-2xl">🗑️</span>
                      <span className="text-sm font-bold">刪除</span>
                      <span className="text-[10px] text-red-100/70">
                        上傳者
                      </span>
                    </button>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-1 px-1 opacity-45">
                      <span className="text-2xl">🔒</span>
                      <span className="text-sm font-bold">刪除</span>
                      <span className="text-[10px] text-white/50">無權限</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="w-full rounded-[22px] border border-white/20 bg-black/80 backdrop-blur-xl px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">⭐</span>
                  <span className="font-bold">參賽作品</span>
                </div>

                <div className="text-right text-xs text-white/70 leading-relaxed">
                  <p>上傳日期</p>
                  <p>{new Date(item.created_at).toLocaleString()}</p>
                </div>
              </div>
            </article>
          ))
        )}
      </section>

      {commentOpen && selectedVideo && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center">
          <div className="w-full max-w-[430px] max-h-[85vh] rounded-t-[28px] sm:rounded-[28px] bg-zinc-950 border border-white/15 shadow-2xl flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-black">留言</h2>
                <p className="text-xs text-white/50">
                  共 {selectedVideo.comment_count || 0} 則留言
                </p>
              </div>

              <button
                onClick={closeComments}
                className="w-10 h-10 rounded-full bg-white/10 text-xl"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
              {comments.length === 0 ? (
                <p className="text-white/50 text-sm text-center py-8">
                  目前尚無留言，成為第一個留言的人吧！
                </p>
              ) : (
                comments.map((comment) => (
                  <div
                    key={comment.id}
                    className="rounded-2xl bg-white/10 border border-white/10 px-4 py-3"
                  >
                    <p className="text-sm leading-relaxed">
                      {comment.content}
                    </p>
                    <p className="text-[10px] text-white/40 mt-2">
                      {new Date(comment.created_at).toLocaleString()}
                    </p>
                  </div>
                ))
              )}
            </div>

            <div className="p-4 border-t border-white/10 flex gap-2">
              <input
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
                placeholder="輸入留言..."
                className="flex-1 rounded-2xl bg-white/10 border border-white/10 px-4 py-3 text-sm outline-none"
              />

              <button
                onClick={submitComment}
                disabled={sendingComment}
                className="rounded-2xl bg-white text-black px-5 py-3 text-sm font-bold"
              >
                {sendingComment ? "送出中" : "送出"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}