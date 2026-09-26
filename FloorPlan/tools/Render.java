import com.eteks.sweethome3d.io.HomeFileRecorder;
import com.eteks.sweethome3d.j3d.PhotoRenderer;
import com.eteks.sweethome3d.model.Home;
import com.eteks.sweethome3d.model.HomeLight;
import com.eteks.sweethome3d.model.HomePieceOfFurniture;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Render the dashboard's photos without opening Sweet Home 3D.
 *
 *   render.sh [shot ...]        (see render.sh for the classpath)
 *
 * Uses Sweet Home 3D's own PhotoRenderer at HIGH quality -- the same SunFlow path the
 * photo dialog takes at its two best settings -- with the camera, time and photo size
 * saved in the render copy. Each shot is `name=Lamp name prefix[,prefix...]`: every lamp
 * whose name starts with one of the prefixes is switched to POWER, every other lamp to
 * 0, and the photo is written to renders/<name>.png. `base=` is the lights-off shot.
 */
public class Render {
    static final float POWER = 0.5f;

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: Render <render copy .sh3d> <out dir> name=prefix[,prefix] ...");
            System.exit(2);
        }
        Home home = new HomeFileRecorder(0, false, null, false, true).readHome(args[0]);
        int width = home.getEnvironment().getPhotoWidth();
        int height = home.getEnvironment().getPhotoHeight();
        List<HomeLight> lights = new ArrayList<>();
        for (HomePieceOfFurniture piece : home.getFurniture()) {
            if (piece instanceof HomeLight) lights.add((HomeLight) piece);
        }
        System.out.println(width + " x " + height + ", " + lights.size() + " lamps, camera "
            + home.getCamera().getClass().getSimpleName());

        for (int i = 2; i < args.length; i++) {
            String name = args[i].substring(0, args[i].indexOf('='));
            String[] on = args[i].substring(args[i].indexOf('=') + 1).split(",");
            StringBuilder lit = new StringBuilder();
            for (HomeLight light : lights) {
                boolean match = false;
                for (String prefix : on) {
                    if (!prefix.isEmpty() && light.getName().startsWith(prefix)) match = true;
                }
                light.setPower(match ? POWER : 0f);
                if (match) lit.append(lit.length() == 0 ? "" : ", ").append(light.getName());
            }
            if (on.length > 0 && !on[0].isEmpty() && lit.length() == 0) {
                throw new IllegalArgumentException(name + ": no lamp name starts with " + String.join(" or ", on));
            }
            long t0 = System.currentTimeMillis();
            // A fresh renderer per shot: it snapshots the scene, lamp powers included.
            PhotoRenderer renderer = new PhotoRenderer(home, PhotoRenderer.Quality.HIGH);
            BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            renderer.render(image, home.getCamera(), null);
            renderer.dispose();
            File out = new File(args[1], name + ".png");
            ImageIO.write(image, "png", out);
            System.out.printf("%-18s %5.1f s  on: %s%n", out.getName(),
                (System.currentTimeMillis() - t0) / 1000.0, lit.length() == 0 ? "nothing" : lit);
        }
        System.exit(0);
    }
}
